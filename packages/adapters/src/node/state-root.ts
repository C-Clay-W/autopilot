/**
 * Node 状态根解析与 schema manifest：集中处理状态目录，不让各 Store 读取 process.cwd()。
 */

import { NodeStateError, toNodeBoundaryError } from "./node-errors";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createNodeStateSchemaManager, type NodeStateSchemaDiagnostic, type NodeStateSchemaMigration } from "./state-schema-manager";
import { readJsonLines, type JsonlCorruptionDiagnostic } from "./file-utils";
import { normalizeNodeSession } from "./session-record";

/** 当前共享 durable 状态清单版本；旧数据没有清单时按既有布局兼容读取。 */
export const NODE_STATE_SCHEMA_VERSION = 6;
/** workspace identity 算法版本；路径布局变更时显式升级以避免碰撞。 */
export const NODE_WORKSPACE_ID_VERSION = 1;

/** Durable JSONL 扫描结果；只包含相对文件名和行号，不包含业务记录正文。 */
export interface NodeStateCorruptionDiagnostic extends JsonlCorruptionDiagnostic {
  file: string;
}

/** 当前已知的逐级迁移；v0 是缺少 manifest 的历史兼容布局。 */
const NODE_STATE_SCHEMA_MIGRATIONS: readonly NodeStateSchemaMigration[] = [{
  fromVersion: 0,
  toVersion: 1,
  migrate() {
    // v0 的目录布局已与 v1 兼容，迁移仅在 staging 根写入 manifest。
  },
}, {
  fromVersion: 1,
  toVersion: 2,
  migrate(stagingRoot) {
    fs.mkdirSync(path.join(stagingRoot, "jobs"), { recursive: true });
  },
}, {
  fromVersion: 2,
  toVersion: 3,
  migrate(stagingRoot) {
    fs.mkdirSync(path.join(stagingRoot, "mutations"), { recursive: true });
    fs.mkdirSync(path.join(stagingRoot, "mutation-blobs"), { recursive: true });
    fs.mkdirSync(path.join(stagingRoot, "mutation-locks"), { recursive: true });
    fs.mkdirSync(path.join(stagingRoot, "undo-transactions"), { recursive: true });
  },
}, {
  fromVersion: 3,
  toVersion: 4,
  migrate(stagingRoot) {
    fs.mkdirSync(path.join(stagingRoot, "questions"), { recursive: true });
  },
}, {
  fromVersion: 4,
  toVersion: 5,
  /** 仅在迁移副本补写产品身份；缺失归属只能采用唯一已有 Project，不能猜工作区。 */
  migrate(stagingRoot) {
    const sessions = path.join(stagingRoot, "sessions");
    if (!fs.existsSync(sessions)) return;
    const projects = path.join(stagingRoot, "projects");
    const candidates = fs.existsSync(projects) ? fs.readdirSync(projects).filter(
      /** 只检查现有 Project 记录，不创建新的工作区身份。 */
      function projectFile(file) { return file.endsWith(".json"); },
    ) : [];
    for (const file of fs.readdirSync(sessions)) {
      if (!file.endsWith(".json")) continue;
      const target = path.join(sessions, file);
      const value = JSON.parse(fs.readFileSync(target, "utf8"));
      if (value && value.productMode === undefined && value.projectId === undefined && candidates.length === 1) {
        const project = JSON.parse(fs.readFileSync(path.join(projects, candidates[0]), "utf8"));
        if (project.id === candidates[0].slice(0, -5) && typeof project.workspaceRoot === "string" && project.workspaceRoot) value.projectId = project.id;
      }
      const session = normalizeNodeSession(value, file.slice(0, -5));
      fs.writeFileSync(target, JSON.stringify(session, null, 2), "utf8");
    }
  },
}, {
  fromVersion: 5,
  toVersion: 6,
  migrate() {
    // v6 冻结 Job owner/revision/CAS 契约；旧 Job 文件由 JobService 按 v1 只读兼容。
  },
}];

/** 一个状态根下各 durable Store 的固定目录布局。 */
export interface NodeStatePaths {
  root: string;
  schemaFile: string;
  sessionsDir: string;
  checkpointsDir: string;
  transcriptsDir: string;
  projectsDir: string;
  turnsDir: string;
  approvalsDir: string;
  inboxDir: string;
  leasesDir: string;
  jobsDir: string;
  mutationsDir: string;
  mutationBlobsDir: string;
  mutationLocksDir: string;
  undoTransactionsDir: string;
  questionsDir: string;
}

/** 将存在的路径解析为 realpath；不存在的路径仍返回规范化绝对路径。 */
export function canonicalizeNodePath(candidate: string, baseDirectory = process.cwd()): string {
  const resolved = path.resolve(baseDirectory, candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** 为 canonical workspaceRoot 创建稳定且不暴露原始路径的状态目录标识。 */
export function createNodeWorkspaceId(workspaceRoot: string, baseDirectory?: string): string {
  const canonicalRoot = canonicalizeNodePath(workspaceRoot, baseDirectory);
  const digest = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24);
  return `v${NODE_WORKSPACE_ID_VERSION}-${digest}`;
}

/** 解析跨启动目录稳定的全局状态根；优先使用宿主显式配置。 */
export function resolveNodeGlobalStateRoot(options: { globalStateRoot?: string; cwd?: string } = {}): string {
  const baseDirectory = options.cwd ?? process.cwd();
  const defaultRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "autopilot-agent")
    : path.join(os.homedir(), ".autopilot-agent");
  return canonicalizeNodePath(options.globalStateRoot ?? defaultRoot, baseDirectory);
}

/** 解析共享 Node 状态根：显式 stateRoot 优先，否则按 stable workspace identity 放入全局目录。 */
export function resolveNodeStateRoot(options: { stateRoot?: string; workspaceRoot?: string; globalStateRoot?: string; cwd?: string } = {}): string {
  const baseDirectory = options.cwd ?? process.cwd();
  if (options.stateRoot) return canonicalizeNodePath(options.stateRoot, baseDirectory);
  const workspaceRoot = options.workspaceRoot ?? baseDirectory;
  return path.join(resolveNodeGlobalStateRoot({ globalStateRoot: options.globalStateRoot, cwd: baseDirectory }), "workspaces", createNodeWorkspaceId(workspaceRoot, baseDirectory));
}

/** 解析兼容现有 Web `.local/agent/trust.json` 的信任目录；CLI 可显式提供独立目录。 */
export function resolveNodeTrustRoot(options: { stateRoot: string; trustRoot?: string }): string {
  const stateRoot = canonicalizeNodePath(options.stateRoot);
  return canonicalizeNodePath(options.trustRoot ?? path.resolve(stateRoot, "..", "agent"));
}

/** 根据状态根生成所有 Store 的路径。 */
export function getNodeStatePaths(stateRoot: string): NodeStatePaths {
  const root = canonicalizeNodePath(stateRoot);
  return {
    root,
    schemaFile: path.join(root, "schema.json"),
    sessionsDir: path.join(root, "sessions"),
    checkpointsDir: path.join(root, "checkpoints"),
    transcriptsDir: path.join(root, "transcripts"),
    projectsDir: path.join(root, "projects"),
    turnsDir: path.join(root, "turns"),
    approvalsDir: path.join(root, "approvals"),
    inboxDir: path.join(root, "inbox"),
    leasesDir: path.join(root, "leases"),
    jobsDir: path.join(root, "jobs"),
    mutationsDir: path.join(root, "mutations"),
    mutationBlobsDir: path.join(root, "mutation-blobs"),
    mutationLocksDir: path.join(root, "mutation-locks"),
    undoTransactionsDir: path.join(root, "undo-transactions"),
    questionsDir: path.join(root, "questions"),
  };
}

/** 校验已存在的 schema manifest；缺少 manifest 的历史数据将在 initialize 时迁移。 */
export function assertNodeStateSchema(stateRoot: string): void {
  const paths = getNodeStatePaths(stateRoot);
  if (!fs.existsSync(paths.schemaFile)) return;
  createNodeStateSchemaManager({ stateRoot: paths.root, targetVersion: NODE_STATE_SCHEMA_VERSION, migrations: NODE_STATE_SCHEMA_MIGRATIONS }).verify();
}

/** 确保状态根存在并完成必要的 schema 迁移；迁移失败时不覆盖旧状态。 */
export function ensureNodeStateRoot(stateRoot: string): NodeStatePaths {
  return initializeNodeStateRoot(stateRoot);
}

/** 在 trust 建立后显式初始化或逐级迁移 schema manifest。 */
export function initializeNodeStateRoot(stateRoot: string): NodeStatePaths {
  try {
    if (fs.existsSync(stateRoot) && fs.lstatSync(stateRoot).isSymbolicLink()) throw new NodeStateError("STATE_SCHEMA_UNSAFE_PATH");
    const paths = getNodeStatePaths(stateRoot);
    const manager = createNodeStateSchemaManager({ stateRoot: paths.root, targetVersion: NODE_STATE_SCHEMA_VERSION, migrations: NODE_STATE_SCHEMA_MIGRATIONS });
    manager.migrate();
    return paths;
  } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
}

/** 返回最近一次持久化 schema 迁移的脱敏诊断，供 Doctor 或启动日志使用。 */
export function getNodeStateSchemaDiagnostic(stateRoot: string): NodeStateSchemaDiagnostic | undefined {
  const paths = getNodeStatePaths(stateRoot);
  return createNodeStateSchemaManager({ stateRoot: paths.root, targetVersion: NODE_STATE_SCHEMA_VERSION, migrations: NODE_STATE_SCHEMA_MIGRATIONS }).getDiagnostics();
}

/** 扫描 durable JSONL 的损坏记录；供 agent doctor 或宿主启动诊断调用。 */
export function getNodeStateCorruptionDiagnostics(stateRoot: string): NodeStateCorruptionDiagnostic[] {
  const paths = getNodeStatePaths(stateRoot);
  const directories = [paths.approvalsDir, paths.checkpointsDir, paths.inboxDir, paths.transcriptsDir, paths.questionsDir];
  const diagnostics: NodeStateCorruptionDiagnostic[] = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory).filter((file) => file.endsWith(".jsonl"))) {
      const filePath = path.join(directory, entry);
      const result = readJsonLines<unknown>(filePath);
      for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, file: path.relative(paths.root, filePath) });
    }
  }
  return diagnostics;
}
