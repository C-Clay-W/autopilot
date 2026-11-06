/**
 * GET /api/workspaces/:workspaceId/threads/:threadId/messages
 * POST /api/workspaces/:workspaceId/threads/:threadId/messages
 *
 * GET 只读消息交付列表；POST 发送协作消息。返回 202 只表示消息已持久接受：
 * `run` 由在线宿主 Runner 领取，`notify` 不启动目标，`steer` 必须匹配发送时的活动 Turn。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadId,
  optionalThreadInt,
  readThreadBody,
  requireThreadId,
  requireThreadMode,
  requireThreadText,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 正文上限与 Core 冻结的 32 KiB 一致；服务端再按字节校验一次。 */
const MAX_MESSAGE_CHARS = 32 * 1024;
/** 交接摘要上限与 Core 一致；标题单行限制由 Core 校验。 */
const MAX_HANDOFF_CHARS = 16 * 1024;

/** 校验可选交接参数：只接受 title/markdown 字符串，语义与写入顺序由 Core 判定。 */
function parseHandoff(value: unknown): { title: string; markdown: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("handoff");
  const record = value as Record<string, unknown>;
  const { title, markdown } = record;
  if (typeof title !== "string" || !title.trim() || title.length > 128) throw invalidInput("handoff.title");
  if (typeof markdown !== "string" || !markdown.trim() || Buffer.byteLength(markdown, "utf8") > MAX_HANDOFF_CHARS) throw invalidInput("handoff.markdown");
  return { title, markdown };
}

/** 构造可被协作错误映射识别的参数错误。 */
function invalidInput(name: string): Error & { code: string } {
  const error = new Error(name) as Error & { code: string };
  error.code = "INVALID_INPUT";
  error.name = "ThreadRouteInputError";
  return error;
}

/**
 * 只读消息交付列表；游标与条数上限由 Route 预检，授权、顺序与恢复事实由 Core 判定。
 * 该读取不启动 Turn，也不确认已读。
 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; threadId: string }> }) {
  return runWorkspaceThreadRoute(params, async function readMessages({ threads }) {
    const { threadId } = await params;
    const url = new URL(request.url);
    const groupId = requireThreadId(url.searchParams.get("groupId"), "groupId");
    const cursor = optionalThreadId(url.searchParams.get("cursor"), "cursor", 2_048);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : optionalThreadInt(Number(rawLimit), "limit", 1, 100);
    return NextResponse.json(await threads.messages({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, threadId, ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) }));
  }, { observeOnly: true });
}

/** 接受一条协作消息，并在接受后立即唤醒本宿主 Runner。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; threadId: string }> }) {
  return runWorkspaceThreadRoute(params, async function sendThread({ threads, host }) {
    const { threadId } = await params;
    const body = await readThreadBody(request);
    const groupId = requireThreadId(body.groupId, "groupId");
    const requestId = requireThreadId(body.requestId, "requestId");
    const mode = requireThreadMode(body.mode);
    const content = requireThreadText(body.content, "content", MAX_MESSAGE_CHARS);
    const replyTo = optionalThreadId(body.replyTo, "replyTo");
    const expectedTurnId = optionalThreadId(body.expectedTurnId, "expectedTurnId");
    const handoff = parseHandoff(body.handoff);
    const result = await threads.send({
      protocolVersion: THREAD_PROTOCOL_VERSION,
      groupId,
      threadId,
      requestId,
      mode,
      content,
      ...(replyTo ? { replyTo } : {}),
      ...(expectedTurnId ? { expectedTurnId } : {}),
      ...(handoff ? { handoff } : {}),
    });
    // 唤醒只是加速：持久投递才是事实源，接受不等于目标已启动或已完成。
    host.kick();
    return NextResponse.json({ ...result, accepted: true }, { status: 202 });
  });
}
