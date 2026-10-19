/**
 * Workspace 内持久关键词索引。
 *
 * 索引按物理表原子保存倒排表与受控候选正文，入库和删除增量维护；
 * 普通查询不回读 LanceDB 全表，只有显式修复操作才允许使用向量表快照重建。
 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { VectorOutput } from "../types";

const LEXICAL_SCHEMA_VERSION = 1;
export const LEXICAL_INDEX_VERSION = "lexical-v1";

/** 索引内单条文档的持久表示。 */
interface LexicalDocumentEntry {
  length: number;
  termFrequency: Record<string, number>;
  resourceId?: string;
}

/** 只在候选命中后读取的正文文件。 */
interface StoredLexicalDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

/** 单表关键词索引的磁盘格式。 */
interface LexicalIndexSnapshot {
  schemaVersion: typeof LEXICAL_SCHEMA_VERSION;
  indexVersion: typeof LEXICAL_INDEX_VERSION;
  tableName: string;
  documents: Record<string, LexicalDocumentEntry>;
  postings: Record<string, Record<string, number>>;
  documentFrequency: Record<string, number>;
  updatedAt: number;
}

/** 表示索引缺失或损坏，调用方可选择进入显式修复流程。 */
export class LexicalIndexUnavailableError extends Error {
  /** 创建不携带底层文件内容的稳定索引异常。 */
  constructor(public readonly reason: "missing" | "corrupt" = "corrupt") {
    super("RAG lexical index unavailable");
    this.name = "LexicalIndexUnavailableError";
  }
}

/** 将文本切成兼顾中文单字、双字和英文术语的词项序列。 */
export function tokenizeLexicalText(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();
  for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) tokens.push(word);
  for (const block of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < block.length; index++) tokens.push(block[index]);
    for (let index = 0; index < block.length - 1; index++) tokens.push(block.slice(index, index + 2));
  }
  return tokens;
}

/** 把向量记录转换为关键词索引文档并统计词频。 */
function createLexicalDocument(record: VectorOutput): { entry: LexicalDocumentEntry; stored: StoredLexicalDocument } {
  const tokens = tokenizeLexicalText(`${record.text}\n${JSON.stringify(record.metadata)}`);
  const termFrequency: Record<string, number> = {};
  for (const token of tokens) termFrequency[token] = (termFrequency[token] ?? 0) + 1;
  const resourceId = typeof record.metadata.resourceId === "string" ? record.metadata.resourceId : undefined;
  return { entry: { length: tokens.length, termFrequency, resourceId }, stored: { id: record.id, text: record.text, metadata: record.metadata } };
}

/** 创建一个空的单表索引快照。 */
function createEmptySnapshot(tableName: string): LexicalIndexSnapshot {
  return { schemaVersion: LEXICAL_SCHEMA_VERSION, indexVersion: LEXICAL_INDEX_VERSION, tableName, documents: {}, postings: {}, documentFrequency: {}, updatedAt: Date.now() };
}

/** 从文档集合重新计算文档频率，保证增量删除后统计正确。 */
function refreshDocumentFrequency(snapshot: LexicalIndexSnapshot): void {
  const documentFrequency: Record<string, number> = {};
  const postings: Record<string, Record<string, number>> = {};
  for (const [id, document] of Object.entries(snapshot.documents)) {
    for (const [term, frequency] of Object.entries(document.termFrequency)) {
      documentFrequency[term] = (documentFrequency[term] ?? 0) + 1;
      (postings[term] ??= {})[id] = frequency;
    }
  }
  snapshot.documentFrequency = documentFrequency;
  snapshot.postings = postings;
  snapshot.updatedAt = Date.now();
}

/** 从倒排表增量移除一条旧文档统计。 */
function removeDocumentEntry(snapshot: LexicalIndexSnapshot, id: string): void {
  const existing = snapshot.documents[id];
  if (!existing) return;
  for (const term of Object.keys(existing.termFrequency)) {
    const posting = snapshot.postings[term];
    if (!posting || !(id in posting)) continue;
    delete posting[id];
    snapshot.documentFrequency[term] = Math.max(0, (snapshot.documentFrequency[term] ?? 1) - 1);
    if (Object.keys(posting).length === 0) {
      delete snapshot.postings[term];
      delete snapshot.documentFrequency[term];
    }
  }
  delete snapshot.documents[id];
}

/** 向倒排表增量加入一条新文档统计。 */
function upsertDocumentEntry(snapshot: LexicalIndexSnapshot, id: string, entry: LexicalDocumentEntry): void {
  removeDocumentEntry(snapshot, id);
  snapshot.documents[id] = entry;
  for (const [term, frequency] of Object.entries(entry.termFrequency)) {
    (snapshot.postings[term] ??= {})[id] = frequency;
    snapshot.documentFrequency[term] = (snapshot.documentFrequency[term] ?? 0) + 1;
  }
  snapshot.updatedAt = Date.now();
}

/** 校验磁盘快照结构，拒绝把任意 JSON 当成可查询索引。 */
function isLexicalIndexSnapshot(value: unknown, tableName: string): value is LexicalIndexSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LexicalIndexSnapshot>;
  return snapshot.schemaVersion === LEXICAL_SCHEMA_VERSION
    && snapshot.indexVersion === LEXICAL_INDEX_VERSION
    && snapshot.tableName === tableName
    && Boolean(snapshot.documents && typeof snapshot.documents === "object")
    && Boolean(snapshot.postings && typeof snapshot.postings === "object")
    && Boolean(snapshot.documentFrequency && typeof snapshot.documentFrequency === "object");
}

/** 创建绑定单个 Workspace lexical 根目录的索引服务。 */
export function createLexicalIndex(rootPath: string) {
  const absoluteRoot = path.resolve(rootPath);

  /** 从受控表名派生不可逃逸的索引文件名。 */
  function indexFile(tableName: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(tableName)) throw new LexicalIndexUnavailableError();
    const digest = createHash("sha256").update(tableName).digest("hex").slice(0, 24);
    return path.join(absoluteRoot, `table-${digest}.json`);
  }

  /** 从表名与记录 ID 派生候选正文文件路径。 */
  function documentFile(tableName: string, id: string): string {
    const tableDigest = createHash("sha256").update(tableName).digest("hex").slice(0, 24);
    const documentDigest = createHash("sha256").update(id).digest("hex");
    return path.join(absoluteRoot, `table-${tableDigest}-documents`, `${documentDigest}.json`);
  }

  /** 读取并校验索引；缺失或损坏统一返回不可用。 */
  async function load(tableName: string): Promise<LexicalIndexSnapshot> {
    try {
      const parsed: unknown = JSON.parse(await readFile(indexFile(tableName), "utf8"));
      if (!isLexicalIndexSnapshot(parsed, tableName)) throw new LexicalIndexUnavailableError("corrupt");
      return parsed;
    } catch (error) {
      if (error instanceof LexicalIndexUnavailableError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LexicalIndexUnavailableError("missing");
      if (error instanceof SyntaxError) throw new LexicalIndexUnavailableError("corrupt");
      throw error;
    }
  }

  /** 原子保存索引，避免进程中断留下半份倒排表。 */
  async function save(snapshot: LexicalIndexSnapshot): Promise<void> {
    await mkdir(absoluteRoot, { recursive: true });
    const target = indexFile(snapshot.tableName);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }

  /** 原子保存单条候选正文，避免查询索引时加载全部正文。 */
  async function saveDocument(tableName: string, document: StoredLexicalDocument): Promise<void> {
    const target = documentFile(tableName, document.id);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }

  /** 读取一条已命中候选正文并校验其记录 ID。 */
  async function loadDocument(tableName: string, id: string): Promise<StoredLexicalDocument> {
    try {
      const parsed = JSON.parse(await readFile(documentFile(tableName, id), "utf8")) as Partial<StoredLexicalDocument>;
      if (parsed.id !== id || typeof parsed.text !== "string" || !parsed.metadata || typeof parsed.metadata !== "object") throw new LexicalIndexUnavailableError("corrupt");
      return parsed as StoredLexicalDocument;
    } catch (error) {
      if (error instanceof LexicalIndexUnavailableError) throw error;
      throw new LexicalIndexUnavailableError((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt");
    }
  }

  /** 增量写入或替换同 ID 文档，并同步更新文档频率。 */
  async function upsert(tableName: string, records: VectorOutput[]): Promise<void> {
    let snapshot: LexicalIndexSnapshot;
    try { snapshot = await load(tableName); } catch (error) {
      if (!(error instanceof LexicalIndexUnavailableError) || error.reason !== "missing") throw error;
      snapshot = createEmptySnapshot(tableName);
    }
    for (const record of records) {
      const document = createLexicalDocument(record);
      await saveDocument(tableName, document.stored);
      upsertDocumentEntry(snapshot, record.id, document.entry);
    }
    await save(snapshot);
  }

  /** 删除一个资源的全部关键词文档，操作可重复执行。 */
  async function removeResource(tableName: string, resourceId: string): Promise<number> {
    let snapshot: LexicalIndexSnapshot;
    try { snapshot = await load(tableName); } catch (error) {
      if (error instanceof LexicalIndexUnavailableError) return 0;
      throw error;
    }
    let removed = 0;
    const removedIds: string[] = [];
    for (const [id, document] of Object.entries(snapshot.documents)) {
      if (document.resourceId === resourceId) {
        removeDocumentEntry(snapshot, id);
        removedIds.push(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      snapshot.updatedAt = Date.now();
      await save(snapshot);
      await Promise.all(removedIds.map(function removeDocument(id) { return rm(documentFile(tableName, id), { force: true }); }));
    }
    return removed;
  }

  /** 删除整张表的关键词索引，只供对应向量表明确清空时调用。 */
  async function clear(tableName: string): Promise<void> {
    await rm(indexFile(tableName), { force: true });
    await rm(path.dirname(documentFile(tableName, "document")), { recursive: true, force: true });
  }

  /** 使用持久倒排统计执行 BM25，只检查包含查询词的候选文档。 */
  async function search(tableName: string, query: string, limit: number): Promise<VectorOutput[]> {
    const snapshot = await load(tableName);
    const queryTerms = [...new Set(tokenizeLexicalText(query))];
    const documents = Object.values(snapshot.documents);
    if (queryTerms.length === 0 || documents.length === 0) return [];
    const averageLength = documents.reduce(function sumLength(sum, document) { return sum + document.length; }, 0) / documents.length || 1;
    const candidateIds = new Set<string>();
    for (const term of queryTerms) {
      for (const id of Object.keys(snapshot.postings[term] ?? {})) candidateIds.add(id);
    }
    const rankedIds = [...candidateIds].map(function scoreDocument(id) {
      const document = snapshot.documents[id];
      const score = queryTerms.reduce(function sumTermScore(sum, term) {
        const frequency = document.termFrequency[term] ?? 0;
        if (frequency === 0) return sum;
        const documentFrequency = snapshot.documentFrequency[term] ?? 0;
        const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * document.length / averageLength);
        return sum + idf * frequency * 2.2 / denominator;
      }, 0);
      return { id, score };
    });
    const selected = rankedIds.sort(function highestScoreFirst(left, right) { return right.score - left.score; }).slice(0, Math.max(0, limit));
    return Promise.all(selected.map(async function loadCandidate(item) {
      const document = await loadDocument(tableName, item.id);
      return { id: document.id, text: document.text, metadata: document.metadata, score: item.score };
    }));
  }

  /** 从持久索引读取表内受控候选，供页码与视觉定位使用。 */
  async function listRecords(tableName: string): Promise<VectorOutput[]> {
    const snapshot = await load(tableName);
    return Promise.all(Object.keys(snapshot.documents).map(async function output(id) {
      const document = await loadDocument(tableName, id);
      return { id: document.id, text: document.text, metadata: document.metadata, score: 0 };
    }));
  }

  /** 通过调用方提供的受控 LanceDB 快照显式重建损坏或缺失索引。 */
  async function rebuild(tableName: string, loadRecords: () => Promise<VectorOutput[]>): Promise<number> {
    const records = await loadRecords();
    const snapshot = createEmptySnapshot(tableName);
    await rm(path.dirname(documentFile(tableName, "document")), { recursive: true, force: true });
    for (const record of records) {
      const document = createLexicalDocument(record);
      await saveDocument(tableName, document.stored);
      snapshot.documents[record.id] = document.entry;
    }
    refreshDocumentFrequency(snapshot);
    await save(snapshot);
    return records.length;
  }

  return { upsert, removeResource, clear, search, listRecords, rebuild };
}
