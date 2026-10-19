/**
 * vision-analyze-tool.test.ts — 注入式视觉工具契约
 *
 * 验证工具只使用 Turn 注入能力，不读取 LLM_* 或固定 Provider 配置。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../tool-executor";
import { ToolRegistry } from "../tool-registry";
import { createVisionAnalyzeTool } from "./vision-analyze-tool";

const temporaryRoots: string[] = [];

afterEach(async function removeTemporaryRoots() {
  await Promise.all(temporaryRoots.splice(0).map(function removeRoot(root) { return rm(root, { recursive: true, force: true }); }));
});

describe("vision_analyze", function visionAnalyzeSuite() {
  it("仅在注入视觉能力时调用，并保留受控路径和 MIME 输出", async function usesInjectedAnalyzer() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autopilot-vision-"));
    temporaryRoots.push(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "image.png"), Buffer.from([137, 80, 78, 71]));
    const analyze = vi.fn(async function analyzeImage() { return "观察结果"; });
    const tool = createVisionAnalyzeTool();
    const output = await tool.execute({ path: "image.png", prompt: "图片有什么" }, {
      workspaceRoot,
      permissionMode: "ask",
      agentFlow: { async search() { return []; }, async searchAcrossTables() { return { results: [] }; } },
      visionAnalyzer: { analyze },
    });
    expect(output).toMatchObject({ path: "image.png", observation: "观察结果", mimeType: "image/png", bytes: 4 });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("缺少注入能力时返回稳定 capability unavailable", async function rejectsMissingCapability() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autopilot-vision-"));
    temporaryRoots.push(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "image.png"), Buffer.from([137, 80, 78, 71]));
    const tool = createVisionAnalyzeTool();
    await expect(tool.execute({ path: "image.png", prompt: "图片有什么" }, {
      workspaceRoot,
      permissionMode: "ask",
      agentFlow: { async search() { return []; }, async searchAcrossTables() { return { results: [] }; } },
    })).rejects.toMatchObject({ toolError: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("拒绝旧 RAG 视觉引用，通用视觉只接受任务文件", function rejectsRagVisualEvidence() {
    const tool = createVisionAnalyzeTool();
    expect(tool.inputSchema.safeParse({ visualEvidenceRef: "rag-resource:resource_0123456789abcdef0123456789abcdef:page:2", prompt: "读取图表" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ path: "image.png", visualEvidenceRef: "forged", prompt: "读取图表" }).success).toBe(false);
  });

  it("auto_approve 将视觉工具视为只读操作，并按工作区约束复用授权", async function autoApprovesWorkspaceVision() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autopilot-vision-"));
    temporaryRoots.push(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "band-0.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(path.join(workspaceRoot, "band-1.png"), Buffer.from([137, 80, 78, 71]));
    const analyze = vi.fn(async function analyzeImage() { return "观察结果"; });
    const grantConstraints: string[] = [];
    const registry = new ToolRegistry();
    registry.register(createVisionAnalyzeTool());
    const executor = new ToolExecutor(registry, {
      workspaceRoot,
      permissionMode: "auto_approve",
      visionAnalyzer: { analyze },
      resolvePersistentGrant: async function resolvePersistentGrant({ constraint }) {
        grantConstraints.push(constraint ?? "");
        return constraint === "vision-analyze:workspace";
      },
      agentFlow: { async search() { return []; }, async searchAcrossTables() { return { results: [] }; } },
    });

    const first = await executor.execute({ callId: "vision-0", toolName: "vision_analyze", input: { path: "band-0.png", prompt: "描述图片" } });
    const second = await executor.execute({ callId: "vision-1", toolName: "vision_analyze", input: { path: "band-1.png", prompt: "继续描述" } });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(grantConstraints).toEqual(["vision-analyze:workspace", "vision-analyze:workspace"]);
    expect(createVisionAnalyzeTool().createActionFacts({ path: "band-0.png", prompt: "描述图片" }, { workspaceRoot, permissionMode: "ask" })).toMatchObject({ risk: "read_only", requiresApproval: true, stableConstraint: "vision-analyze:workspace" });
  });
});
