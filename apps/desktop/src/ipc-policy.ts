// IPC 来源同时核对主窗口、顶层 frame 和完整页面 URL。
import { isUiPreferences } from "./ui-preferences";
import { isApPermissionMode, isAgentType, isNewTerminalType, type WorkspaceCommand } from "./workspace";
/** 只允许当前主窗口顶层页面调用无参数的启动接口。 */
export function isBootstrapRequestAllowed(senderId: number, windowId: number, isMainFrame: boolean, senderUrl: string, expectedUrl: string, argumentCount: number): boolean {
  return senderId === windowId && isMainFrame && senderUrl === expectedUrl && argumentCount === 0;
}

/** 仅允许有限的标量字段进入主进程命令，不接受任意对象或进程参数。 */
export function isWorkspaceCommand(value: unknown): value is WorkspaceCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    workspaceCreate: ["type", "requestId", "directory", "apPermission"], apPermissionPreference: ["type", "permission"], uiPreference: ["type", "ui"], create: ["type", "requestId", "mode", "apPermission", "directory", "agent", "agentSelected", "desktopWorkspaceId"], workspaceActivate: ["type", "desktopWorkspaceId"], workspaceDelete: ["type", "desktopWorkspaceId"], workspaceRename: ["type", "desktopWorkspaceId", "name"], preference: ["type", "agent"], terminalPreference: ["type", "terminal"], add: ["type", "tabId", "axis"], directory: ["type", "tabId", "directory"], close: ["type", "tabId", "paneId"], retry: ["type", "tabId", "paneId"], activate: ["type", "tabId", "paneId"], expand: ["type", "tabId", "paneId"], arrange: ["type", "tabId", "axis"], ratio: ["type", "tabId", "path", "ratio"],
  };
  if (typeof data.type !== "string" || !Object.hasOwn(fields, data.type) || Object.keys(data).some(function unknown(key) { return !fields[data.type as string].includes(key); })) return false;
  /** 身份仅使用宿主生成的短标识，拒绝路径或控制字符。 */
  function id(value: unknown): boolean { return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value); }
  if (data.type === "apPermissionPreference") return isApPermissionMode(data.permission);
  if ((data.type === "create" || data.type === "workspaceCreate") && data.apPermission !== undefined && !isApPermissionMode(data.apPermission)) return false;
  if (data.type === "uiPreference") return isUiPreferences(data.ui);
  if (data.type === "preference") return isAgentType(data.agent);
  if (data.type === "terminalPreference") return isNewTerminalType(data.terminal);
  if (data.type === "workspaceActivate" || data.type === "workspaceDelete") return id(data.desktopWorkspaceId);
  if (data.type === "workspaceCreate") return id(data.requestId) && typeof data.directory === "string" && data.directory.length > 0 && data.directory.length <= 32768 && !data.directory.includes("\0");
  if (data.type === "workspaceRename") return id(data.desktopWorkspaceId) && typeof data.name === "string" && data.name.trim().length > 0 && data.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(data.name);
  if (data.type === "create") return isAgentType(data.agent) && (data.agentSelected === undefined || typeof data.agentSelected === "boolean") && (data.desktopWorkspaceId === null || id(data.desktopWorkspaceId)) && id(data.requestId) && ["x2", "x4", "freedom"].includes(data.mode as string) && (data.directory === null || typeof data.directory === "string" && data.directory.length <= 32768 && !data.directory.includes("\0"));
  if (!id(data.tabId)) return false;
  if (data.type === "directory") return typeof data.directory === "string" && data.directory.length > 0 && data.directory.length <= 32768 && !data.directory.includes("\0");
  if (data.type === "add" || data.type === "arrange") return data.axis === "row" || data.axis === "column";
  if (data.type === "ratio") return typeof data.path === "string" && /^[01]*$/.test(data.path) && typeof data.ratio === "number" && Number.isFinite(data.ratio) && data.ratio >= 0.15 && data.ratio <= 0.85;
  if (data.type === "retry") return id(data.paneId);
  if (data.type === "expand") return data.paneId === null || id(data.paneId);
  return data.paneId === undefined || id(data.paneId);
}

/** 固定终端请求的身份、代次与长度均在信任边界校验。 */
export function isTerminalRequest(args: unknown[], kind: "read" | "write" | "resize"): boolean {
  if (args.length !== (kind === "resize" ? 4 : 3) || typeof args[0] !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(args[0]) || !Number.isSafeInteger(args[1]) || (args[1] as number) < 1) return false;
  if (kind === "read") return Number.isSafeInteger(args[2]) && (args[2] as number) >= 0;
  if (kind === "write") return typeof args[2] === "string" && args[2].length <= 65536;
  return Number.isInteger(args[2]) && Number.isInteger(args[3]) && (args[2] as number) >= 2 && (args[2] as number) <= 1000 && (args[3] as number) >= 1 && (args[3] as number) <= 1000;
}
