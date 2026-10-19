/**
 * migrate-legacy-session-projections.mjs — 一次性迁移旧 Web JSONL 会话展示投影
 *
 * 将 `.local/sessions/*.jsonl` 中可供 UI 展示的 meta、message、compact 记录迁入
 * Core Node SessionStore 的 `Session.presentation`。它不读取或重建旧的运行态事件，
 * 运行完成并核验后可用 `--delete-source` 删除旧目录。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const legacySessionsDirectory = path.resolve(scriptDirectory, "..", ".local", "sessions");
const runtimeSessionsDirectory = path.resolve(scriptDirectory, "..", ".local", "runtime", "sessions");
const deleteSource = process.argv.includes("--delete-source");

/** 读取 JSONL 中的合法记录；损坏尾行不阻断已持久化的历史迁移。 */
function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split("\n").flatMap(function parseLine(line) {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** 剥离旧 JSONL 的记录类型标签，形成 Core Session presentation 的稳定数据。 */
function toPresentation(records) {
  const meta = records.find(function findMeta(record) { return record.type === "session_meta"; });
  if (!meta || typeof meta.id !== "string") return null;
  const messages = records.filter(function isMessage(record) { return record.type === "message"; }).map(function omitType(record) {
    const { type, ...message } = record;
    void type;
    return message;
  });
  const compactions = records.filter(function isCompaction(record) { return record.type === "agent_compaction"; }).map(function omitType(record) {
    const { type, ...compaction } = record;
    void type;
    return compaction;
  });
  return {
    meta,
    presentation: {
      messages,
      ...(Array.isArray(meta.pinnedSkills) ? { pinnedSkills: meta.pinnedSkills } : {}),
      ...(compactions.length > 0 ? { compactions } : {}),
    },
  };
}

/** 原子替换 Session JSON，避免迁移中断留下半个 Core Session 文件。 */
function writeSession(filePath, session) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

/** 迁移全部旧会话；已有非空 presentation 的 Core Session 保持为权威数据。 */
function migrate() {
  if (!fs.existsSync(legacySessionsDirectory)) {
    console.log("没有发现旧 Web .local/sessions 目录，无需迁移。");
    return { migrated: 0, preserved: 0, invalid: 0 };
  }
  fs.mkdirSync(runtimeSessionsDirectory, { recursive: true });
  let migrated = 0;
  let preserved = 0;
  let invalid = 0;
  for (const name of fs.readdirSync(legacySessionsDirectory).filter(function isJsonl(fileName) { return fileName.endsWith(".jsonl"); }).sort()) {
    const sourcePath = path.join(legacySessionsDirectory, name);
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
    const source = toPresentation(readJsonLines(sourcePath));
    if (!source) {
      invalid += 1;
      continue;
    }
    const targetPath = path.join(runtimeSessionsDirectory, `${source.meta.id}.json`);
    let session;
    if (fs.existsSync(targetPath)) {
      session = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      if ((session.presentation?.messages?.length ?? 0) > 0) {
        preserved += 1;
        continue;
      }
    } else {
      session = {
        id: source.meta.id,
        persistenceMode: "durable",
        status: "idle",
        title: source.meta.title,
        createdAt: source.meta.createdAt,
        updatedAt: source.meta.updatedAt,
        schemaVersion: 1,
      };
    }
    session.presentation = source.presentation;
    session.title ??= source.meta.title;
    session.updatedAt = Math.max(session.updatedAt ?? 0, source.meta.updatedAt ?? 0);
    writeSession(targetPath, session);
    migrated += 1;
  }
  console.log(`旧 Web 会话投影迁移完成：迁入 ${migrated} 个，保留 ${preserved} 个既有投影，无效 ${invalid} 个。`);
  return { migrated, preserved, invalid };
}

const result = migrate();
if (deleteSource && fs.existsSync(legacySessionsDirectory) && result.invalid === 0) {
  fs.rmSync(legacySessionsDirectory, { recursive: true, force: false });
  console.log("已删除已迁移的旧 Web .local/sessions 目录。");
} else if (deleteSource && result.invalid > 0) {
  throw new Error("存在未迁移的旧会话，拒绝删除来源目录。");
}
