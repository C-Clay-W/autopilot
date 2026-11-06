/**
 * runtime/application/session-service.ts — Session 用例编排
 *
 * 封装 Session 的 CRUD 操作与默认运行配置管理，不实现业务规则，只编排 SessionStore。
 * Phase 3 引入；为未来 P0 阶段的 Web Session 管理提供共享入口。
 */

import { readSessionIdentity } from "../domain/product-mode";
import type { ProductMode, ChatRetrievalMode } from "../domain/product-mode";
import { randomUUID } from "node:crypto";
import type { RuntimePorts } from "../ports";
import type { Session, SessionPersistenceMode, SessionRunConfig } from "../domain";
import { AgentRuntimeError as RuntimeError } from "../protocol";
import type { InternalJobService, JobService } from "./job-service";
import type { SessionDirectoryPage, SessionDirectoryQuery } from "../ports/session-store";

/** SessionService 接口。 */
export interface SessionService {
  /** 创建新 Session。 */
  create(input: CreateSessionInput): Promise<Session>;

  /** 列出当前宿主可见的全部 Session。 */
  list(): Promise<Session[]>;

  /** 按Project分页读取标题与UUID，不读取正文或触发恢复。 */
  listDirectoryPage(query: SessionDirectoryQuery): Promise<SessionDirectoryPage>;

  /** 根据 ID 读取 Session。 */
  get(id: string): Promise<Session | null>;

  /** 保存或更新 Session。 */
  save(session: Session): Promise<void>;

  /** 设置 Session 级默认运行配置。 */
  setDefaultRunConfig(id: string, runConfig: SessionRunConfig): Promise<Session>;

  /** 更新 Session 的用户可见标题。 */
  rename(id: string, title: string): Promise<Session>;

  /** 删除指定 Session。 */
  delete(id: string): Promise<boolean>;
}

/** 创建 Session 的输入。 */
export interface CreateSessionInput {
  /** 兼容迁移时可保留既有 ID；正常新建由 Core 生成。 */
  id?: string;
  /** 服务端来源；省略仅兼容既有 Work 宿主。 */
  productMode?: ProductMode;
  chatRetrievalMode?: ChatRetrievalMode;
  projectId?: string;
  persistenceMode?: SessionPersistenceMode;
  title?: string;
  defaultRunConfig?: SessionRunConfig;
}

/** 创建 SessionService 实例。 */
export function createSessionService(ports: RuntimePorts, jobService?: JobService): SessionService {
  return {
    create,
    list,
    listDirectoryPage,
    get,
    save,
    setDefaultRunConfig,
    rename,
    delete: deleteSession,
  };

  /** 创建前校验身份及 ID；旧 Work 调用方缺省 projectId 时只复用宿主绑定工作区。 */
  async function create(input: CreateSessionInput): Promise<Session> {
    return createSessionRecord(ports, input);
  }

  /** 读取列表时只校验身份并返回副本，不执行旧数据迁移。 */
  async function list(): Promise<Session[]> {
    const sessions = await ports.sessionStore.list();
    for (const session of sessions) readSessionIdentity(session);
    return structuredClone(sessions);
  }

  /** 只调用明确提供的目录能力，旧适配器不偷偷降级为全量list。 */
  async function listDirectoryPage(query: SessionDirectoryQuery): Promise<SessionDirectoryPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || !query.projectId.trim()) throw new RuntimeError("INVALID_INPUT", "目录分页参数无效");
    if (!ports.sessionStore.listDirectoryPage) throw new RuntimeError("INVALID_INPUT", "当前存储不支持轻量会话目录");
    return structuredClone(await ports.sessionStore.listDirectoryPage(query));
  }

  /** 返回隔离副本，避免内存 Store 被调用方先修改再绕过 save 校验。 */
  async function get(id: string): Promise<Session | null> {
    const session = await ports.sessionStore.get(id);
    if (!session) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session ${id} 不存在`);
    }
    readSessionIdentity(session);
    return structuredClone(session);
  }

  /** 只保存既有 Session，产品、检索与既有 Project 归属不可原地改写。 */
  async function save(session: Session): Promise<void> {
    const stored = await ports.sessionStore.get(session.id);
    if (!stored) throw new RuntimeError("SESSION_NOT_FOUND", "Session 不存在");
    const identity = readSessionIdentity(stored);
    const next = readSessionIdentity(session);
    if (JSON.stringify(stored.collaborationAllowedTools) !== JSON.stringify(session.collaborationAllowedTools)) throw new RuntimeError("SESSION_MODE_MISMATCH", "协作能力上限不可修改");
    if (JSON.stringify(stored.creationSource) !== JSON.stringify(session.creationSource)) throw new RuntimeError("SESSION_MODE_MISMATCH", "Session 创建来源不可修改");
    if (stored.collaborationCreationId !== session.collaborationCreationId) throw new RuntimeError("SESSION_MODE_MISMATCH", "Session 协作创建身份不可修改");
    if (stored.workContextVersion !== session.workContextVersion) throw new RuntimeError("SESSION_MODE_MISMATCH", "Session 来源版本不可修改");
    if (identity.productMode !== next.productMode || (stored.projectId !== undefined && stored.projectId !== session.projectId)) {
      throw new RuntimeError("SESSION_MODE_MISMATCH", "Session 产品模式与归属不可修改");
    }
    if (identity.chatRetrievalMode !== next.chatRetrievalMode) throw new RuntimeError("CHAT_RETRIEVAL_MODE_LOCKED", "Chat 检索模式已冻结");
    if (stored.productMode !== undefined && session.productMode === undefined) throw new RuntimeError("SESSION_MODE_MISMATCH", "Session 产品身份不可移除");
    await ports.sessionStore.save(structuredClone({ ...session, updatedAt: ports.clock.now() }));
  }

  /** 默认运行参数不承载产品身份；后续 Turn 仍从 Session 派生能力上限。 */
  async function setDefaultRunConfig(id: string, runConfig: SessionRunConfig): Promise<Session> {
    const session = await ports.sessionStore.get(id);
    if (!session) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session ${id} 不存在`);
    }
    session.defaultRunConfig = runConfig;
    session.updatedAt = ports.clock.now();
    await ports.sessionStore.save(session);
    return structuredClone(session);
  }

  /** 校验并保存用户显式设置的标题，避免宿主直接修改 Store DTO。 */
  async function rename(id: string, title: string): Promise<Session> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || normalizedTitle.length > 200) {
      throw new RuntimeError("SESSION_TITLE_INVALID", "Session 标题不能为空且最长 200 个字符");
    }
    const session = await ports.sessionStore.get(id);
    if (!session) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session ${id} 不存在`);
    }
    session.title = normalizedTitle;
    session.updatedAt = ports.clock.now();
    await ports.sessionStore.save(session);
    return structuredClone(session);
  }

  /** 先清理宿主资源，再级联删除 Runtime 状态。 */
  async function deleteSession(id: string): Promise<boolean> {
    return ports.threadStore.withSessionLock(id, async function deleteWithThreadLock() {
      if (await ports.threadStore.hasMembership(id)) throw new RuntimeError("THREAD_HAS_PENDING_WORK", "Session 仍被协作组引用");
      return deleteWithJobLock(id);
    });
  }

  /** 组合既有 Job 锁，避免资源清理和新 Job 并发。 */
  async function deleteWithJobLock(id: string): Promise<boolean> {
    if (jobService && "withSessionLock" in jobService) {
      return (jobService as InternalJobService).withSessionLock(id, function deleteWithJobLock() { return deleteInsideLock(id); });
    }
    return deleteInsideLock(id);
  }

  /** 在 Job 启动共享锁内完成活动检查和全部级联删除。 */
  async function deleteInsideLock(id: string): Promise<boolean> {
    const session = await ports.sessionStore.get(id);
    if (!session) return false;
    const turns = await ports.turnStore.list(id);
    if (turns.some((turn) => turn.status === "running" || turn.status === "waiting_approval" || turn.status === "waiting_user_input")) {
      throw new RuntimeError("TURN_ALREADY_RUNNING", `Session ${id} 仍有活动 Turn，必须先取消并确认停止`);
    }
    if (jobService ? await jobService.hasActiveJobs(id) : (await ports.jobStore.listBySession(id)).some((job) => job.status === "starting" || job.status === "running" || job.status === "stopping")) {
      throw new RuntimeError("SESSION_HAS_ACTIVE_JOBS", `Session ${id} 仍有活动 Job，必须先 job kill`);
    }
    // 先清理宿主资源；失败时保留 Core 状态，避免出现半删除 Session。
    await ports.sessionResourceStore.deleteBySession(id);
    await ports.leaseStore.deleteBySession(id);
    await ports.inputInbox.deleteBySession(id);
    await ports.approvalStore.deleteBySession(id);
    await ports.checkpointStore.deleteBySession(id);
    await ports.transcriptStore.deleteBySession(id);
    await ports.turnStore.deleteBySession(id);
    await ports.jobStore.deleteBySession(id);
    await ports.fileMutationStore.deleteBySession(id);
    await ports.userQuestionStore.deleteBySession(id);
    return ports.sessionStore.delete(id);
  }
}

/** 仅供已鉴权 ThreadService 调用的内部创建入口；不注册公开 facade，不接受模型或 HTTP 自报来源。 */
export async function createSessionForThread(ports: RuntimePorts, input: CreateSessionInput & { id: string }, creation: { creationId: string; source: NonNullable<Session["creationSource"]> }): Promise<Session> {
  return createSessionRecord(ports, input, creation);
}

/** 普通与 Thread 创建共用身份/Project/配置规则；协作意图只增加原子幂等与可信来源。 */
async function createSessionRecord(ports: RuntimePorts, input: CreateSessionInput, creation?: { creationId: string; source: NonNullable<Session["creationSource"]> }): Promise<Session> {
  const productMode = input.productMode === undefined ? "work" : input.productMode;
  let projectId = input.projectId;
  if (productMode === "work" && !projectId && input.productMode === undefined && input.chatRetrievalMode === undefined) {
    const workspaceRoot = await ports.workspaceAdapter.resolveWorkspaceRoot();
    if (!workspaceRoot) throw new RuntimeError("WORKSPACE_REQUIRED", "Work 需要有效工作区归属");
    /** 只复用宿主当前工作区对应的 Project，缺失时再创建。 */
    const project = (await ports.projectStore.list()).find(function matchesWorkspace(item) { return item.workspaceRoot === workspaceRoot; })
      ?? await ports.projectStore.create({ name: "Workspace", workspaceRoot });
    projectId = project.id;
  }
  readSessionIdentity({ productMode, chatRetrievalMode: input.chatRetrievalMode, projectId });
  if (productMode === "work") {
    const project = await ports.projectStore.get(projectId!);
    const workspaceRoot = await ports.workspaceAdapter.resolveWorkspaceRoot();
    if (!project || project.workspaceRoot !== workspaceRoot) throw new RuntimeError("WORKSPACE_REQUIRED", "Work 必须归属当前宿主工作区 Project");
  }
  if (!creation && input.id && await ports.sessionStore.get(input.id)) throw new RuntimeError("SESSION_MODE_MISMATCH", "Session ID 已存在，不能覆盖身份");
  const now = ports.clock.now();
  const session: Session = {
    id: input.id ?? randomUUID(),
    ...(creation ? { collaborationCreationId: creation.creationId, creationSource: structuredClone(creation.source) } : {}),
    productMode,
    ...(productMode === "work" ? { workContextVersion: 1 as const } : {}),
    chatRetrievalMode: input.chatRetrievalMode,
    projectId,
    persistenceMode: input.persistenceMode ?? "durable",
    status: "idle",
    title: input.title,
    defaultRunConfig: input.defaultRunConfig,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
  if (creation) {
    if (!await ports.sessionStore.createIfAbsent(session)) {
      const existing = await ports.sessionStore.get(session.id);
      if (!existing || existing.collaborationCreationId !== creation.creationId || JSON.stringify(existing.creationSource) !== JSON.stringify(creation.source) || existing.productMode !== session.productMode || existing.projectId !== session.projectId) throw new RuntimeError("SESSION_MODE_MISMATCH", "Session 创建身份冲突");
      return structuredClone(existing);
    }
  } else await ports.sessionStore.save(session);
  return structuredClone(session);
}
