// Desktop 只读状态协议，只定义白名单数据、帧校验与有界 UTF-8 分帧，不持有业务或传输生命周期。
export const DESKTOP_STATUS_VERSION = 1;
export const DESKTOP_STATUS_FRAME_BYTES = 64 * 1024;
export const DESKTOP_STATUS_QUEUE_BYTES = 256 * 1024;
export interface DesktopSessionStatus {
  sessionId: string; turnId?: string; selected: boolean;
  relation: "opened" | "locallyDriven" | "relatedObserved";
  freshness: "fresh" | "unknown";
  status: "idle" | "running" | "waiting_approval" | "waiting_user_input" | "completed" | "failed" | "interrupted";
  execution?: "active" | "inactive" | "unconfirmed" | "lost";
  waiting?: "approval" | "user_input" | "threads";
  result?: "completed" | "failed" | "interrupted" | "limit_reached";
  interaction?: "pending" | "decided" | "expired" | "unconfirmed";
  continuation?: "pending" | "applied" | "rejected" | "claimed" | "executing" | "completed" | "failed";
  recoverable?: boolean; lastSeq: number;
}
export interface DesktopWorkspaceStatus { workspaceId: string; stateRootId: string; projectId: string; displayName: string }
export interface DesktopStatusIdentity { desktopInstanceId: string; paneId: string; generation: number; apInstanceId: string }
export type DesktopStatusFrame = DesktopStatusIdentity & { protocolVersion: 1; seq: number } & (
  | { type: "hello"; token: string; cliVersion: string }
  | { type: "snapshot"; snapshotId: string; part: number; final: boolean; lifecycle: "starting" | "ready"; workspace?: DesktopWorkspaceStatus; sessions: DesktopSessionStatus[] }
  | { type: "heartbeat" }
  | { type: "ap_exiting" }
);
export type DesktopStatusReply = { type: "accepted" | "ack" | "resync_required"; seq: number };

/** 只接受无路径和控制字符的内部身份。 */
export function isDesktopStatusId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(value); }
/** 逐字段白名单校验，附带正文或未知字段整帧拒绝。 */
function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && required.every(function present(key) { return Object.prototype.hasOwnProperty.call(value, key); }) && Object.keys(value).every(function allowed(key) { return required.includes(key) || optional.includes(key); });
}
/** 枚举字段缺省合法，已有值必须在稳定白名单内。 */
function optionalEnum(value: unknown, values: string[]): boolean { return value === undefined || typeof value === "string" && values.includes(value); }
/** 验证每个安全会话事实，不接受交互正文或原始错误。 */
export function isDesktopSessionStatus(value: unknown): value is DesktopSessionStatus {
  if (!fields(value, ["sessionId", "selected", "relation", "freshness", "status", "lastSeq"], ["turnId", "execution", "waiting", "result", "interaction", "continuation", "recoverable"])) return false;
  return isDesktopStatusId(value.sessionId) && (value.turnId === undefined || isDesktopStatusId(value.turnId)) && typeof value.selected === "boolean"
    && ["opened", "locallyDriven", "relatedObserved"].includes(value.relation as string) && ["fresh", "unknown"].includes(value.freshness as string)
    && ["idle", "running", "waiting_approval", "waiting_user_input", "completed", "failed", "interrupted"].includes(value.status as string)
    && Number.isSafeInteger(value.lastSeq) && (value.lastSeq as number) >= 0
    && optionalEnum(value.execution, ["active", "inactive", "unconfirmed", "lost"]) && optionalEnum(value.waiting, ["approval", "user_input", "threads"])
    && optionalEnum(value.result, ["completed", "failed", "interrupted", "limit_reached"]) && optionalEnum(value.interaction, ["pending", "decided", "expired", "unconfirmed"])
    && optionalEnum(value.continuation, ["pending", "applied", "rejected", "claimed", "executing", "completed", "failed"])
    && (value.recoverable === undefined || typeof value.recoverable === "boolean");
}
/** 工作区只含 canonical 摘要身份与短名称。 */
function workspace(value: unknown): boolean {
  return fields(value, ["workspaceId", "stateRootId", "projectId", "displayName"]) && isDesktopStatusId(value.workspaceId) && isDesktopStatusId(value.stateRootId) && isDesktopStatusId(value.projectId)
    && typeof value.displayName === "string" && value.displayName.length <= 80 && !/[\x00-\x1f\x7f/\\]/.test(value.displayName);
}
/** 版本、身份与每种帧的字段均独立校验。 */
export function isDesktopStatusFrame(value: unknown): value is DesktopStatusFrame {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const common = ["protocolVersion", "desktopInstanceId", "paneId", "generation", "apInstanceId", "seq", "type"];
  if (v.protocolVersion !== 1 || !isDesktopStatusId(v.desktopInstanceId) || !isDesktopStatusId(v.paneId) || !isDesktopStatusId(v.apInstanceId) || !Number.isSafeInteger(v.generation) || (v.generation as number) < 1 || !Number.isSafeInteger(v.seq) || (v.seq as number) < 1) return false;
  if (v.type === "hello") return fields(v, [...common, "token", "cliVersion"]) && typeof v.token === "string" && /^[0-9a-f]{64}$/.test(v.token) && typeof v.cliVersion === "string" && /^\d+\.\d+\.\d+[-\w.]*$/.test(v.cliVersion);
  if (v.type === "heartbeat" || v.type === "ap_exiting") return fields(v, common);
  return v.type === "snapshot" && fields(v, [...common, "snapshotId", "part", "final", "lifecycle", "sessions"], ["workspace"])
    && isDesktopStatusId(v.snapshotId) && Number.isSafeInteger(v.part) && (v.part as number) >= 0 && typeof v.final === "boolean"
    && ["starting", "ready"].includes(v.lifecycle as string) && (v.workspace === undefined || workspace(v.workspace)) && (v.lifecycle !== "ready" || v.workspace !== undefined)
    && Array.isArray(v.sessions) && v.sessions.length <= 128 && v.sessions.every(isDesktopSessionStatus)
    && (v.lifecycle !== "starting" || v.sessions.length === 0 && v.workspace === undefined);
}
/** 控制回复只能确认序号或请求全量同步。 */
export function isDesktopStatusReply(value: unknown): value is DesktopStatusReply {
  return fields(value, ["type", "seq"]) && ["accepted", "ack", "resync_required"].includes(value.type as string) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0;
}
/** 字节上限先于解码生效，跨 chunk UTF-8 只在完整行解码。 */
export class DesktopStatusLines {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    const values: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.pending.length + end - offset > DESKTOP_STATUS_FRAME_BYTES) throw new Error("STATUS_FRAME_INVALID");
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const line = new TextDecoder("utf-8", { fatal: true }).decode(this.pending);
      this.pending = Buffer.alloc(0);
      values.push(JSON.parse(line));
      offset = newline + 1;
    }
    return values;
  }
}
