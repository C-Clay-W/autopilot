// 原生浏览器工具仅在受信 Desktop 注入时注册，审批由统一浏览器宿主执行。
import { z } from "zod";
import { prepareStaticPreview, resolveStaticPreviewFile } from "./static-preview";
import type { JobService } from "../../../runtime/application/job-service";
import { browserOperationSchema, isPublicBrowserRead } from "../../../runtime/protocol/browser-operation";
export { browserOperationSchema } from "../../../runtime/protocol/browser-operation";
import type { AgentToolDefinition } from "../types";
import type { BrowserBinding, BrowserCapability, BrowserOperation } from "../../../runtime/protocol/browser-capability";
import { prepareMcpImages } from "../mcp-images";
import type { SessionImageStore } from "../../../runtime/ports/session-image-store";
import type { AgentImageReference } from "../../types/agent-message";

/** 审批只显示 HTTP(S) 站点，去掉凭据、路径、查询和页面内容。 */
function browserDisplayOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin.length <= 320) return url.origin;
  } catch { /* 没有可信站点时使用标签标识。 */ }
}

/** 真实回合绑定闭包不可被模型参数或其他工具覆写。 */
export function createBrowserTool(capability: BrowserCapability, binding: BrowserBinding, store?: SessionImageStore, preview?: { jobs: JobService; workspaceRoot: string; workspaceId: string }): AgentToolDefinition<BrowserOperation | { type: "open"; staticPath: string }, unknown> {
  const references = new WeakMap<object, AgentImageReference[]>();
  const observedPages = new Map<string, { revision: number; origin: string }>();

  /** 只记录本工具实例收到的宿主标签事实，列表更新覆盖已知页面。 */
  function observePage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const page = value as { id?: unknown; revision?: unknown; url?: unknown; loading?: unknown; error?: unknown };
    if (typeof page.id !== "string" || page.id.length !== 36 || typeof page.revision !== "number" || !Number.isSafeInteger(page.revision)) return;
    observedPages.delete(page.id);
    if (page.loading === true || page.error) return;
    const origin = typeof page.url === "string" ? browserDisplayOrigin(page.url) : undefined;
    if (!origin) return;
    if (observedPages.size >= 128) {
      const oldest = observedPages.keys().next();
      if (!oldest.done) observedPages.delete(oldest.value);
    }
    observedPages.set(page.id, { revision: page.revision, origin });
  }

  /** 目标需要匹配已知网页代次，未知站点显示标签标识和元素引用。 */
  function approvalTarget(operation: BrowserOperation): string | undefined {
    if ("url" in operation) return browserDisplayOrigin(operation.url);
    if (!("pageId" in operation)) return;
    const page = observedPages.get(operation.pageId);
    const target = page?.revision === operation.revision ? page.origin : `网页地址待确认（标签 ${operation.pageId}）`;
    return "ref" in operation ? `${target} · ${operation.ref}` : target;
  }

  return {
    name: "browser",
    description: "操作 Desktop 内置浏览器。预览用户指定的Markdown/HTML（含明确选择的工作区外文件）优先使用document动作的path字段，由Desktop按精确文件确认。工作区旧预览亦兼容 {type:\"open\",staticPath:\"相对文档路径\"}，经进程审批复用受管单文件服务，不要自行启动临时服务器；Markdown不执行原始HTML/脚本或加载远程资源。每次只传一个明确动作；先 list/open 得到 pageId 与 revision，snapshot 获取当前元素 @eN。打开不代表验证成功。导航后重新 list/snapshot 获取代次与元素。once 是单步，always 仅当前用户回合；宿主会要求确认。同页被占用时等待用户处理，不自动重试、接管或重复可能已生效的动作。不提供任意脚本或原始 CDP。",
    inputSchema: z.union([browserOperationSchema, z.object({ type: z.literal("open"), staticPath: z.string().min(1).max(512) }).strict()]),
    /** 审批前确定所选文件边界，不允许未装配Job的宿主启动服务。 */
    async validateInput(operation) {
      if (!("staticPath" in operation)) return;
      if (!preview) throw new Error("PREVIEW_UNAVAILABLE");
      await resolveStaticPreviewFile(preview.workspaceRoot, operation.staticPath);
    },
    metadata: { effect: "external", destructive: false, concurrency: { max: 1, resourceKey: "browser:caller" }, retry: { safe: false }, timeout: { defaultMs: 600_000, maxMs: 600_000 } },
    /** 浏览器宿主统一审批；保留 Core 工具白名单、策略与取消边界。 */
    createActionFacts(operation, context) {
      if ("staticPath" in operation) return { toolName: "browser", effect: "external", destructive: false, operation: "prepare_static_preview", risk: "external_side_effect", requiresApproval: true, requireSingleApproval: true, approval: { reason: "准备受管本机单文件预览服务需要进程执行确认", preview: { staticPath: operation.staticPath } } };
      const readOnly = (context.permissionMode === "full_access" || context.permissionMode === "auto_approve") && isPublicBrowserRead(operation);
      const confirmsDocument = context.permissionMode === "full_access" && operation.type === "document" && capability.confirmsDocument === true;
      const resource = approvalTarget(operation);
      const hosted = capability.managesApprovals === true || confirmsDocument;
      return { toolName: "browser", effect: "external", destructive: false, operation: operation.type, resource, risk: readOnly || hosted ? "read_only" : "external_side_effect", requiresApproval: false,
        ...(!hosted && !readOnly ? { requireSingleApproval: true as const } : {}) };
    },
    /** 调用ID缺失时拒绝，不用随机值伪装原生工具调用。 */
    async execute(operation, context) {
      if (!context.toolCallId) throw new Error("BROWSER_CALL_ID_REQUIRED");
      const target = "staticPath" in operation
        ? { type: "open" as const, url: (await prepareStaticPreview({ ...preview!, sessionId: binding.sessionId, turnId: binding.turnId, staticPath: operation.staticPath }, context)).url }
        : operation;
      const raw = capability.managesApprovals || context.permissionMode === "full_access"
        ? await capability.request(binding, context.toolCallId, target, context.signal, { mode: context.permissionMode, ...(context.browserApprovalConsumed ? { approvedOnce: true } : {}) })
        : await capability.request(binding, context.toolCallId, target, context.signal);
      if (target.type === "list" && Array.isArray(raw)) {
        observedPages.clear();
        for (const page of raw.slice(-128)) observePage(page);
      } else if (target.type === "snapshot" && raw && typeof raw === "object" && "origin" in raw) {
        observePage({ id: target.pageId, revision: target.revision, url: raw.origin });
      } else if (target.type === "open" || target.type === "navigate" || target.type === "document") observePage(raw);
      else if (target.type === "close") observedPages.delete(target.pageId);
      const prepared = await prepareMcpImages(raw, store, binding.sessionId, context.signal);
      if (prepared.output && typeof prepared.output === "object") references.set(prepared.output, prepared.images);
      return prepared.output;
    },
    /** 宿主返回已限长的页面结果，不把连接凭据交给模型。 */
    serializeOutput(output) { return output; },
    /** 图片经既有会话图片存储校验，模型正文仅含受信引用。 */
    getImageReferences(output) { return output && typeof output === "object" ? references.get(output) ?? [] : []; },
  };
}
