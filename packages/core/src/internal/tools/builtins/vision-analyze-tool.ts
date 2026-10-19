/**
 * vision_analyze 工具：只读取受控工作区图片，并调用 Turn 注入的视觉能力，不经过 RAG。
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertRegularFile } from "../permissions/workspace-path";
import { resolveFileTarget } from "../permissions/path-access-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition } from "../types";

const maxImageBytes = 5 * 1024 * 1024;
const visionAnalyzeSchema = z.object({
  path: z.string().min(1),
  prompt: z.string().trim().min(1).max(4_000),
}).strict();

/** 根据受控文件扩展名选择明确 MIME 类型，拒绝未知二进制输入。 */
function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const mimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
  const mimeType = mimeByExtension[extension];
  if (!mimeType) throw createToolError(TOOL_ERROR_CODES.BINARY_FILE, "vision_analyze 仅支持 PNG、JPEG、WEBP 或 GIF 图片");
  return mimeType;
}

/** 创建由 Runtime 注入视觉能力的通用视觉理解工具定义。 */
export function createVisionAnalyzeTool(): AgentToolDefinition<z.infer<typeof visionAnalyzeSchema>, Record<string, unknown>> {
  return {
    name: "vision_analyze",
    description: "分析工作区内的任务图片；只有实际调用成功后才能声称看过图片。",
    inputSchema: visionAnalyzeSchema,
    metadata: { effect: "external", destructive: false, concurrency: { max: 2, resourceKey: "vision:provider" }, retry: { safe: false }, timeout: { defaultMs: 60_000, maxMs: 120_000 } },
    createActionFacts: (input) => ({
      toolName: "vision_analyze",
      effect: "external",
      destructive: false,
      operation: "analyze",
      resource: input.path,
      risk: "read_only",
      stableConstraint: "vision-analyze:workspace",
      requiresApproval: true,
      approval: { reason: "向配置的视觉 Provider 发送受控图片需要用户审批", preview: { path: input.path } },
    }),
    async execute(input, context) {
      // Talk-Plan1013 Stage 1：读取外部图片免新增路径审批；向视觉 Provider 外发仍按既有审批执行。
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      if (!target.exists) throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "图片文件不存在");
      await assertRegularFile(target.absolutePath);
      const metadata = await stat(target.absolutePath);
      if (metadata.size > maxImageBytes) throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "图片超过 5 MB 输入上限");
      const mimeType = getMimeType(target.absolutePath);
      const buffer = await readFile(target.absolutePath);
      const imageDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
      if (context.signal?.aborted) throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消视觉分析");
      if (!context.visionAnalyzer) throw createToolError(TOOL_ERROR_CODES.CAPABILITY_UNAVAILABLE, "当前 Turn 未配置可用视觉能力");
      let observation: string;
      try {
        observation = await context.visionAnalyzer.analyze({
          systemPrompt: "你是视觉分析工具。只描述图片中可观察到的事实、文字、布局与不确定点；不要编造文件或外部知识。",
          prompt: input.prompt,
          imageDataUrl,
          signal: context.signal,
        });
      } catch (error) {
        if (context.signal?.aborted) throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消视觉分析");
        if (error instanceof Error && error.message === "VISION_CAPABILITY_UNAVAILABLE") throw createToolError(TOOL_ERROR_CODES.CAPABILITY_UNAVAILABLE, "视觉能力缺少有效凭据或端点");
        throw createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, "视觉分析调用失败");
      }
      return { path: target.isExternal ? target.canonicalTarget : target.relativePath!, observation, mimeType, bytes: buffer.byteLength };
    },
    serializeOutput(output) { return output; },
  };
}
