/**
 * Node durable 状态 schema 迁移器：在副本中逐级迁移，备份后才原子切换状态根。
 */

import { NodeStateError, toNodeBoundaryError } from "./node-errors";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 迁移副本不能跟随链接或复制仍在写入的临界区；发现异常立即保留原目录。 */
function assertPlainStateTree(root: string): void {
  const entry = fs.lstatSync(root);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new NodeStateError("STATE_SCHEMA_UNSAFE_PATH");
  if (!entry.isDirectory()) return;
  for (const name of fs.readdirSync(root)) {
    if (name.endsWith(".lock")) throw new NodeStateError("STATE_SCHEMA_BUSY");
    assertPlainStateTree(path.join(root, name));
  }
}

/** 原子占用短期迁移锁；只回收已退出进程的锁，不抢占仍存活的迁移。 */
function acquireSchemaLock(root: string): number {
  const lock = `${root}.schema-lock`;
  fs.mkdirSync(path.dirname(root), { recursive: true });
  try {
    const descriptor = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(descriptor, String(process.pid));
    return descriptor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (fs.lstatSync(lock).isSymbolicLink()) throw new NodeStateError("STATE_SCHEMA_UNSAFE_PATH");
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new NodeStateError("STATE_SCHEMA_BUSY");
    try { process.kill(pid, 0); }
    catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
        fs.unlinkSync(lock);
        return acquireSchemaLock(root);
      }
    }
    throw new NodeStateError("STATE_SCHEMA_BUSY");
  }
}

/** 单个迁移只能处理相邻版本，避免跨版本条件分支掩盖升级路径。 */
export interface NodeStateSchemaMigration {
  fromVersion: number;
  toVersion: number;
  migrate(stagingRoot: string): void;
}

/** 已完成迁移的受信宿主诊断；含备份路径，不得直接投影到用户响应。 */
export interface NodeStateSchemaDiagnostic {
  code: "STATE_SCHEMA_MIGRATED";
  fromVersion: number;
  toVersion: number;
  backupPath: string;
  migratedAt: string;
}

/** schema manifest 的最小持久化结构；额外字段仅用于恢复诊断。 */
interface NodeStateSchemaManifest {
  schemaVersion: number;
  lastMigration?: NodeStateSchemaDiagnostic;
}

/** 状态 schema 迁移器的显式配置。 */
export interface CreateNodeStateSchemaManagerOptions {
  stateRoot: string;
  targetVersion: number;
  migrations: readonly NodeStateSchemaMigration[];
}

/** 用于读取、迁移、备份和验证某个 durable 状态根的最小协议。 */
export interface NodeStateSchemaManager {
  detectVersion(): number;
  migrate(fromVersion?: number, toVersion?: number): NodeStateSchemaDiagnostic | undefined;
  backup(fromVersion: number, toVersion: number): string | undefined;
  verify(expectedVersion?: number): void;
  getDiagnostics(): NodeStateSchemaDiagnostic | undefined;
}

/** 判断目录是否含有除 schema manifest 外的 durable 内容。 */
function hasDurableState(root: string): boolean {
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root).some(function isDurableEntry(entry) {
    return entry !== "schema.json";
  });
}

/** 读取 schema manifest；损坏或非法版本必须停止，不能猜测用户数据版本。 */
function readManifest(root: string): NodeStateSchemaManifest | undefined {
  const filePath = path.join(root, "schema.json");
  if (!fs.existsSync(filePath)) return undefined;
  if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(filePath).isFile() || fs.lstatSync(filePath).isSymbolicLink()) throw new NodeStateError("STATE_SCHEMA_UNSAFE_PATH");
  const content = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new NodeStateError("STATE_SCHEMA_MANIFEST_CORRUPTED");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new NodeStateError("STATE_SCHEMA_MANIFEST_CORRUPTED");
  const manifest = parsed as Partial<NodeStateSchemaManifest>;
  if (!Number.isInteger(manifest.schemaVersion) || (manifest.schemaVersion as number) < 0) {
    throw new NodeStateError("STATE_SCHEMA_VERSION_INVALID");
  }
  return manifest as NodeStateSchemaManifest;
}

/** 向 staging 根写入校验后的 manifest；实际状态根只在整次迁移成功后接收该文件。 */
function writeManifest(root: string, schemaVersion: number, diagnostic?: NodeStateSchemaDiagnostic): void {
  fs.mkdirSync(root, { recursive: true });
  const manifest: NodeStateSchemaManifest = { schemaVersion, ...(diagnostic ? { lastMigration: diagnostic } : {}) };
  fs.writeFileSync(path.join(root, "schema.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/** 生成状态根相邻的备份目录，避免备份进入待迁移目录而被二次复制。 */
function createBackupPath(root: string, fromVersion: number, toVersion: number): string {
  const backupRoot = path.join(path.dirname(root), `${path.basename(root)}.schema-backups`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(backupRoot, `${timestamp}-v${fromVersion}-to-v${toVersion}-${randomUUID()}`);
}

/** 创建状态根的完整快照；无 durable 数据的新根无需生成空备份。 */
function backupStateRoot(root: string, fromVersion: number, toVersion: number): string | undefined {
  if (!hasDurableState(root)) return undefined;
  assertPlainStateTree(root);
  const backupPath = createBackupPath(root, fromVersion, toVersion);
  const backupRoot = path.dirname(backupPath);
  if (fs.existsSync(backupRoot) && fs.lstatSync(backupRoot).isSymbolicLink()) throw new NodeStateError("STATE_SCHEMA_UNSAFE_PATH");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.cpSync(root, backupPath, { recursive: true, errorOnExist: true });
  return backupPath;
}

/** 创建 schema 管理器；迁移始终在副本运行并逐级校验。 */
export function createNodeStateSchemaManager(options: CreateNodeStateSchemaManagerOptions): NodeStateSchemaManager {
  const root = path.resolve(options.stateRoot);
  const originalRoot = `${root}.schema-original`;
  const stagingRoot = `${root}.schema-staging`;

  /** 检测当前版本；有旧数据但无 manifest 时按兼容布局定义为 v0。 */
  function detectVersion(): number {
    try {
      const manifest = readManifest(root);
      if (manifest) return manifest.schemaVersion;
      return hasDurableState(root) ? 0 : options.targetVersion;
    } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
  }

  /** 返回已保存的上次迁移诊断，不读取任何业务记录内容。 */
  function getDiagnostics(): NodeStateSchemaDiagnostic | undefined {
    try {
      return readManifest(root)?.lastMigration;
    } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
  }

  /** 校验当前 manifest 的版本，供 Store 在使用状态根前 fail closed。 */
  function verify(expectedVersion = options.targetVersion): void {
    try {
      const version = detectVersion();
      if (version !== expectedVersion) throw new NodeStateError("STATE_SCHEMA_VERSION_UNSUPPORTED");
    } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
  }

  /** 为指定相邻迁移生成只读恢复快照。 */
  function backup(fromVersion: number, toVersion: number): string | undefined {
    try {
      return backupStateRoot(root, fromVersion, toVersion);
    } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
  }

  /** 从当前版本逐级迁移至目标版本；失败时原状态根和备份均保留。 */
  function migrate(fromVersion?: number, toVersion = options.targetVersion): NodeStateSchemaDiagnostic | undefined {
    try {
      if (!fs.existsSync(originalRoot) && !fs.existsSync(stagingRoot) && fs.existsSync(root) && readManifest(root)?.schemaVersion === toVersion) {
        verify(toVersion);
        return getDiagnostics();
      }
      const descriptor = acquireSchemaLock(root);
      try {
        // 两次 rename 之间进程退出时，先恢复旧根；新根已提交则只收尾旧副本。
        if (fs.existsSync(originalRoot)) {
          if (!fs.lstatSync(originalRoot).isDirectory()) throw new NodeStateError("STATE_SCHEMA_UNSAFE_PATH");
          assertPlainStateTree(originalRoot);
          if (!fs.existsSync(root)) fs.renameSync(originalRoot, root);
          else if (readManifest(root)?.schemaVersion === toVersion) fs.rmSync(originalRoot, { recursive: true });
          else throw new NodeStateError("STATE_SCHEMA_RECOVERY_REQUIRED");
        }
        if (fs.existsSync(stagingRoot)) {
          assertPlainStateTree(stagingRoot);
          fs.rmSync(stagingRoot, { recursive: true });
        }
        return migrateLocked(fromVersion ?? detectVersion(), toVersion);
      } finally {
        fs.closeSync(descriptor);
        fs.unlinkSync(`${root}.schema-lock`);
      }
    } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
  }

  /** 在迁移锁内完成逐级复制、备份与切换，所有临时目录名均由状态根确定。 */
  function migrateLocked(fromVersion: number, toVersion: number): NodeStateSchemaDiagnostic | undefined {
    if (!fs.existsSync(root) || (!hasDurableState(root) && !readManifest(root))) {
      writeManifest(root, toVersion);
      return undefined;
    }
    if (fromVersion === toVersion) {
      verify(toVersion);
      return getDiagnostics();
    }
    if (fromVersion > toVersion || fromVersion < 0 || toVersion < 0) {
      throw new NodeStateError("STATE_SCHEMA_VERSION_UNSUPPORTED");
    }
    if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
      throw new NodeStateError("STATE_SCHEMA_VERSION_INVALID");
    }

    const backupPath = backup(fromVersion, toVersion);
    try {
      if (fs.existsSync(root)) fs.cpSync(root, stagingRoot, { recursive: true, errorOnExist: true });
      else fs.mkdirSync(stagingRoot, { recursive: true });
      let currentVersion = fromVersion;
      while (currentVersion < toVersion) {
        const step = options.migrations.find(function findAdjacentMigration(candidate) {
          return candidate.fromVersion === currentVersion && candidate.toVersion === currentVersion + 1;
        });
        if (!step) throw new NodeStateError("STATE_SCHEMA_MIGRATION_MISSING");
        step.migrate(stagingRoot);
        currentVersion = step.toVersion;
      }
      const diagnostic: NodeStateSchemaDiagnostic | undefined = backupPath
        ? { code: "STATE_SCHEMA_MIGRATED", fromVersion, toVersion, backupPath, migratedAt: new Date().toISOString() }
        : undefined;
      writeManifest(stagingRoot, toVersion, diagnostic);
      const stagedManifest = readManifest(stagingRoot);
      if (stagedManifest?.schemaVersion !== toVersion) throw new NodeStateError("STATE_SCHEMA_MANIFEST_CORRUPTED");

      if (!fs.existsSync(root)) {
        fs.renameSync(stagingRoot, root);
        return diagnostic;
      }
      fs.renameSync(root, originalRoot);
      try {
        fs.renameSync(stagingRoot, root);
      } catch (error) {
        fs.renameSync(originalRoot, root);
        throw error;
      }
      try { fs.rmSync(originalRoot, { recursive: true, force: true }); }
      catch { /* 新根已经提交；下次初始化在迁移锁内重试旧副本收尾，不能声称原状态未覆盖。 */ }
      return diagnostic;
    } catch (error) {
      // 清理失败也保留原始失败分类，固定 staging 由下次初始化重试清理。
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); }
      catch { /* 原状态和备份保留，不能用清理异常覆盖迁移失败。 */ }
      const reason = toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE");
      throw new NodeStateError("STATE_SCHEMA_MIGRATION_FAILED", { fromVersion, toVersion, backupPath, reasonCode: reason.code });
    }
  }

  return { detectVersion, migrate, backup, verify, getDiagnostics };
}
