/** open_preview 工具：经 ToolExecutor/PolicyEngine 授权后调用宿主 Work 预览能力，只准备导航交付。 */

import { z } from "zod";
import type { AgentToolDefinition } from "../types";
import type { WorkPreviewCapability, WorkPreviewPrepareResult } from "../../../runtime/protocol/work-preview-capability";

const schema = z.object({
  url: z.string().min(1).max(2_048),
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  openWhen: z.enum(["now", "after_turn"]).optional(),
}).strict();

/** 创建 open_preview 工具；仅在受信宿主注入 WorkPreviewCapability 的 Work Turn 注册，Chat/CLI 永不注册。 */
export function createOpenPreviewTool(input: {
  capability: WorkPreviewCapability;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}): AgentToolDefinition<z.infer<typeof schema>, WorkPreviewPrepareResult> {
  return {
    name: "open_preview",
    description:
      "根据用户意图、会话上下文与当前成果判断是否有展示必要，并选择适当时机准备内置浏览器预览；url 必须来自可靠信息，缺地址或存在多个候选时先询问。成功只表示预览请求已准备，实际显示由用户端处理；本工具不读取、不验证、不操作网页内容。",
    inputSchema: schema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "workspace:open-preview" }, retry: { safe: false }, timeout: { defaultMs: 35_000, maxMs: 35_000 } },
    /** 生成本地可信事实：预览属于外部效果且默认需要审批，模型输入不能改变风险边界。 */
    async createActionFacts(value) {
      return {
        toolName: "open_preview",
        effect: "external",
        destructive: false,
        operation: "preview",
        risk: "external_side_effect",
        requiresApproval: true,
        approval: {
          reason: "准备内置浏览器预览需要确认；预览只会在内置面板打开页面，不会读取或操作网页内容",
          preview: { url: value.url, jobId: value.jobId, openWhen: value.openWhen ?? "after_turn" },
        },
      };
    },
    /** 调用宿主能力准备导航；身份四元组来自 Runtime 绑定，模型输入无法伪造归属。 */
    async execute(value, context) {
      return input.capability.preparePreview({
        url: value.url,
        ...(value.jobId !== undefined ? { jobId: value.jobId } : {}),
        openWhen: value.openWhen ?? "after_turn",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        callId: context.toolCallId ?? "",
        ...(context.signal ? { signal: context.signal } : {}),
      });
    },
    /** 模型可见输出只含冻结安全事实；copyUrl/hostLabel 仅经受控展示明细进入展示层。 */
    serializeOutput(output) {
      return { previewId: output.previewId, state: output.state, openWhen: output.openWhen, ...(output.autoOpen === false ? { autoOpen: false } : {}) };
    },
    /** 从原始结果生成 open_preview 受控明细；任一字段非法时 fail-closed 返回 undefined。 */
    projectDisplayDetail(output) {
      if (typeof output.previewId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(output.previewId)) return undefined;
      if (typeof output.hostLabel !== "string" || output.hostLabel.length === 0 || output.hostLabel.length > 253) return undefined;
      if (typeof output.copyUrl !== "string" || output.copyUrl.length === 0 || output.copyUrl.length > 2_048) return undefined;
      if (output.state !== "prepared") return undefined;
      if (output.jobId !== undefined && (typeof output.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(output.jobId))) return undefined;
      return {
        kind: "open_preview",
        previewId: output.previewId,
        hostLabel: output.hostLabel,
        copyUrl: output.copyUrl,
        openWhen: output.openWhen,
        state: "prepared",
        ...(output.jobId !== undefined ? { jobId: output.jobId } : {}),
        ...(output.autoOpen === false ? { autoOpen: false } : {}),
      };
    },
  };
}
