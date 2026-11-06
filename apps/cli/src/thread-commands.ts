/**
 * thread-commands.ts — CLI 协作命令到 Core ThreadFacade 的薄映射
 *
 * 只做正文/文件读取、参数整形与输出行生成；组归属、幂等、容量和交付事实都在 Core。
 * 短命令不启动 Runner，也不猜测其它进程是否在线：回执只表示消息已接受，
 * 真正执行仍由在线宿主 Runner 与 Session lease 决定。
 */

import type { ThreadFacade } from "@autopilot-agent/core";
import type { CliExitCode, CliThreadCommand } from "./types.js";

/** 命令输入不合法；Main 映射为 usage 退出码，不进入 Runtime。 */
export class CliThreadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliThreadInputError";
  }
}

/** 命令执行所需的宿主边界能力；测试可注入替身。 */
export interface CliThreadCommandScope {
  threads: ThreadFacade;
  /** 读取 UTF-8 文本；失败时由命令层收敛为固定输入错误。 */
  readFile(path: string): Promise<string>;
  /** 读取全部 stdin；调用方必须已确认用户显式要求从 stdin 读取。 */
  readStdin(): Promise<string>;
  /** watch 的逐行输出；只输出安全事件 JSON。 */
  write(line: string): void;
  /** watch 与 wait 的中止信号；中止只结束观察，不停止目标。 */
  signal: AbortSignal;
  /** watch 轮询间隔；缺省 500ms。 */
  pollIntervalMs?: number;
}

/** 命令执行结果；result 由 Main 统一序列化为 JSON。 */
export interface CliThreadCommandResult {
  exitCode: CliExitCode;
  result?: unknown;
}

/** 协作协议版本固定为 1；与 Web/工具共用同一冻结契约。 */
const THREAD_PROTOCOL_VERSION = 1 as const;

/** watch 的默认轮询间隔；只影响本地观察节奏，不改变持久事实。 */
const DEFAULT_WATCH_POLL_MS = 500;

/** 读取协作正文；空正文在投递前就拒绝，避免把空任务写给目标会话。 */
async function readContent(command: Extract<CliThreadCommand, { type: "send" }>, scope: CliThreadCommandScope): Promise<string> {
  let content: string;
  try {
    content = command.contentSource.kind === "file"
      ? await scope.readFile(command.contentSource.path)
      : await scope.readStdin();
  } catch {
    throw new CliThreadInputError("协作消息正文读取失败");
  }
  if (!content.trim()) throw new CliThreadInputError("协作消息正文不能为空");
  return content;
}

/** 读取显式交接摘要；标题由参数给出，正文只从受控文件读取。 */
async function readHandoff(command: Extract<CliThreadCommand, { type: "send" }>, scope: CliThreadCommandScope): Promise<{ title: string; markdown: string } | undefined> {
  if (!command.handoff) return undefined;
  let markdown: string;
  try {
    markdown = await scope.readFile(command.handoff.markdownFile);
  } catch {
    throw new CliThreadInputError("交接文档读取失败");
  }
  if (!markdown.trim()) throw new CliThreadInputError("交接文档不能为空");
  return { title: command.handoff.title, markdown };
}

/** 读取共享板写入值；只接受合法 JSON，不把裸文本静默当字符串。 */
async function readStateValue(value: { kind: "inline"; json: string } | { kind: "file"; path: string }, scope: CliThreadCommandScope): Promise<unknown> {
  let json: string;
  if (value.kind === "inline") {
    json = value.json;
  } else {
    try {
      json = await scope.readFile(value.path);
    } catch {
      throw new CliThreadInputError("共享板取值读取失败");
    }
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new CliThreadInputError("共享板取值需要合法 JSON");
  }
}

/** 可中止的本地等待；中止只结束观察节奏，不影响任何目标执行。 */
function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(function schedule(resolve) {
    const timer = setTimeout(finish, ms);
    /** 清理定时器与监听，避免中止后残留回调。 */
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** 持续观察组事件；每行一条 JSON，Ctrl+C 只结束观察。 */
async function watchEvents(command: Extract<CliThreadCommand, { type: "watch" }>, scope: CliThreadCommandScope): Promise<CliThreadCommandResult> {
  let cursor = command.cursor;
  while (!scope.signal.aborted) {
    const page = await scope.threads.events({
      protocolVersion: THREAD_PROTOCOL_VERSION,
      groupId: command.groupId,
      ...(cursor ? { cursor } : {}),
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
    });
    for (const event of page.items) scope.write(JSON.stringify(event));
    cursor = page.cursor;
    if (scope.signal.aborted) break;
    // 还有下一页时立即续读，不额外等待。
    if (!page.nextCursor) await waitForPoll(scope.pollIntervalMs ?? DEFAULT_WATCH_POLL_MS, scope.signal);
  }
  return { exitCode: 0 };
}

/**
 * 执行一条协作命令。
 * 参数错误抛 CliThreadInputError；领域错误由 Core 抛出，Main 统一映射退出码。
 */
export async function executeThreadCommand(command: CliThreadCommand, scope: CliThreadCommandScope): Promise<CliThreadCommandResult> {
  if (command.type === "group_of") return { exitCode: 0, result: await scope.threads.groupOf({ protocolVersion: THREAD_PROTOCOL_VERSION, threadId: command.threadId }) };
  if (command.type === "group_enable") {
    return { exitCode: 0, result: await scope.threads.enable({ protocolVersion: THREAD_PROTOCOL_VERSION, requestId: command.requestId, rootThreadId: command.rootThreadId }) };
  }
  if (command.type === "group_disable") {
    return { exitCode: 0, result: await scope.threads.disable({ protocolVersion: THREAD_PROTOCOL_VERSION, requestId: command.requestId, groupId: command.groupId }) };
  }
  if (command.type === "create") {
    return {
      exitCode: 0,
      result: await scope.threads.create({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        requestId: command.requestId,
        groupId: command.groupId,
        parentThreadId: command.parentThreadId,
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.roleLabel !== undefined ? { roleLabel: command.roleLabel } : {}),
        ...(command.modelRef ? { modelRef: command.modelRef } : {}),
        ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}),
      }),
    };
  }
  if (command.type === "bind_host") {
    return { exitCode: 0, result: await scope.threads.bindExecutionHost({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId: command.groupId, threadId: command.threadId, expectedRevision: command.expectedRevision, executionHost: command.executionHost }) };
  }
  if (command.type === "associate") {
    return { exitCode: 0, result: await scope.threads.associate({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId: command.groupId, threadId: command.threadId, requestId: command.requestId }) };
  }
  if (command.type === "list") {
    return {
      exitCode: 0,
      result: await scope.threads.list({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        groupId: command.groupId,
        ...(command.cursor ? { cursor: command.cursor } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      }),
    };
  }
  if (command.type === "read") {
    return {
      exitCode: 0,
      result: await scope.threads.read({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        groupId: command.groupId,
        threadId: command.threadId,
        ...(command.cursor ? { cursor: command.cursor } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      }),
    };
  }
  if (command.type === "send") {
    const content = await readContent(command, scope);
    const handoff = await readHandoff(command, scope);
    return {
      exitCode: 0,
      result: await scope.threads.send({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        requestId: command.requestId,
        groupId: command.groupId,
        threadId: command.threadId,
        mode: command.mode,
        content,
        ...(command.replyTo !== undefined ? { replyTo: command.replyTo } : {}),
        ...(command.expectedTurnId !== undefined ? { expectedTurnId: command.expectedTurnId } : {}),
        ...(handoff ? { handoff } : {}),
      }),
    };
  }
  if (command.type === "wait") {
    return {
      exitCode: 0,
      result: await scope.threads.wait({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        groupId: command.groupId,
        targets: command.targets,
        timeoutMs: command.timeoutMs,
        signal: scope.signal,
      }),
    };
  }
  if (command.type === "state_read") {
    return { exitCode: 0, result: await scope.threads.readState({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId: command.groupId }) };
  }
  if (command.type === "state_set") {
    return {
      exitCode: 0,
      result: await scope.threads.updateState({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        requestId: command.requestId,
        groupId: command.groupId,
        expectedRevision: command.expectedRevision,
        operations: [{ op: "set", key: command.key, value: await readStateValue(command.value, scope) }],
      }),
    };
  }
  if (command.type === "state_remove") {
    return {
      exitCode: 0,
      result: await scope.threads.updateState({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        requestId: command.requestId,
        groupId: command.groupId,
        expectedRevision: command.expectedRevision,
        operations: [{ op: "remove", key: command.key }],
      }),
    };
  }
  if (command.type === "interrupt") {
    return {
      exitCode: 0,
      result: await scope.threads.interrupt({
        protocolVersion: THREAD_PROTOCOL_VERSION,
        requestId: command.requestId,
        groupId: command.groupId,
        threadId: command.threadId,
        expectedTurnId: command.expectedTurnId,
      }),
    };
  }
  return watchEvents(command, scope);
}
