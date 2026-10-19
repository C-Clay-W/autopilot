/** Node Skill discovery 契约测试：兼容 Claude Code 常用 frontmatter，且保持安全 canonical 身份。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillsCapability } from "../src/node/capabilities/skill-discovery.js";

const temporaryRoots: string[] = [];

/** 创建隔离的临时工作区，避免读取真实用户 Skill 目录。 */
function createTemporaryWorkspace(): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-next-skill-"));
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

/** 写入符合 Claude Code 习惯的多行描述和目录不同展示名 Skill。 */
function writeClaudeCompatibleSkill(workspaceRoot: string): void {
  const skillRoot = path.join(workspaceRoot, ".autopilot", "skills", "code-review");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), [
    "---",
    "name: code-review-skill",
    "description: |",
    "  Reviews code changes for correctness and security.",
    "  Use for pull requests and code review.",
    "allowed-tools:",
    "  - Read",
    "  - Grep",
    "---",
    "",
    "# Code Review",
  ].join("\n"));
}

afterEach(function cleanTemporaryRoots() {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Node Skill discovery", function skillDiscoverySuite() {
  it("以目录名识别多行 description 的 Claude Code Skill，frontmatter name 仅作展示", async function discoversClaudeCompatibleSkill() {
    const workspaceRoot = createTemporaryWorkspace();
    writeClaudeCompatibleSkill(workspaceRoot);

    const capability = createSkillsCapability(workspaceRoot, { homeDirectory: path.join(workspaceRoot, "empty-home") });

    expect(capability).toBeDefined();
    expect(capability?.catalog).toMatchObject([{
      qualifiedName: "repo:code-review",
      name: "code-review",
      displayName: "code-review-skill",
      description: "Reviews code changes for correctness and security.\nUse for pull requests and code review.",
      allowedTools: ["Read", "Grep"],
    }]);
    await expect(capability!.loadSkill({ skill: "repo:code-review" })).resolves.toMatchObject({ skillId: expect.stringMatching(/^repo:/) });
  });
});
