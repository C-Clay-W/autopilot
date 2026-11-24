/**
 * GET/POST /api/workspaces/:workspaceId/threads
 *
 * 列出授权组成员 / 在当前组内创建子会话。组与父会话来自人类启用的协作组；
 * 浏览器只能提交标题、角色标签与模型选择，不能指定归属或来源。
 */

import { NextResponse } from "next/server";
import {
  optionalThreadId,
  optionalThreadInt,
  optionalThreadModelRef,
  readThreadBody,
  requireThreadId,
  requireThreadText,
  runWorkspaceThreadRoute,
  THREAD_PROTOCOL_VERSION,
} from "@/lib/workspace-host/thread-route";

/** 允许的推理强度值与 Core `ReasoningEffort` 一致。 */
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/** 创建子会话；创建本身不启动推理。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  return runWorkspaceThreadRoute(params, async function createThread({ threads }) {
    const body = await readThreadBody(request);
    const groupId = requireThreadId(body.groupId, "groupId");
    const parentThreadId = requireThreadId(body.parentThreadId, "parentThreadId");
    const requestId = requireThreadId(body.requestId, "requestId");
    const title = body.title === undefined ? undefined : requireThreadText(body.title, "title", 200);
    const roleLabel = optionalThreadId(body.roleLabel, "roleLabel", 100);
    const modelRef = optionalThreadModelRef(body.modelRef);
    const effort = body.reasoningEffort;
    if (effort !== undefined && !REASONING_EFFORTS.includes(effort as (typeof REASONING_EFFORTS)[number])) {
      return NextResponse.json({ error: "推理强度不合法", code: "INVALID_INPUT" }, { status: 400 });
    }
    const result = await threads.create({
      protocolVersion: THREAD_PROTOCOL_VERSION,
      groupId,
      parentThreadId,
      requestId,
      ...(title !== undefined ? { title } : {}),
      ...(roleLabel !== undefined ? { roleLabel } : {}),
      ...(modelRef !== undefined ? { modelRef } : {}),
      ...(effort !== undefined ? { reasoningEffort: effort as (typeof REASONING_EFFORTS)[number] } : {}),
    });
    return NextResponse.json(result, { status: 201 });
  });
}

/** 列出当前组成员；只返回安全摘要，不枚举整个宿主的会话。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  return runWorkspaceThreadRoute(params, async function listThreads({ threads }) {
    const url = new URL(request.url);
    const groupId = requireThreadId(url.searchParams.get("groupId"), "groupId");
    const cursor = optionalThreadId(url.searchParams.get("cursor"), "cursor", 2_048);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : optionalThreadInt(Number(rawLimit), "limit", 1, 100);
    const result = await threads.list({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) });
    return NextResponse.json(result);
  });
}
