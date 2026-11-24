/** 从 Forge 应用目录启动实际随包 Node 与编排 Worker，在一次性用户目录核对 Skill 身份和正文 hash。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ManagedRuntimeHost } from "../src/managed-runtime-host";
import type { ManagedRuntimeReceipt } from "../src/managed-runtime-service";
import { ORCHESTRATION_SKILL_HASH, ORCHESTRATION_SKILL_ID, ORCHESTRATION_SKILL_VERSION } from "../src/orchestration-skill";

/** 启动真实 Worker，并通过原生 CLI 选 Skill 及准备 prompt，保持零 start 请求。 */
async function verify(appDirectory: string): Promise<void> {
  const app = await realpath(appDirectory);
  const packaged = createRequire(join(app, "package.json"));
  const cliMain = packaged.resolve("@autopilot-agent/cli/dist/main.js");
  const node = join(dirname(app), "node20", process.platform === "win32" ? "node.exe" : "bin/node");
  const bundledAdapters = packaged("@autopilot-agent/adapters") as typeof import("@autopilot-agent/adapters");
  const scratchRoot = await mkdtemp(join(tmpdir(), "ap-packaged-orchestration-"));
  const workspace = join(scratchRoot, "workspace");
  const managedState = join(scratchRoot, "managed-state");
  const userDirectory = join(scratchRoot, "profile");
  const host = new ManagedRuntimeHost(randomUUID());
  try {
    const shadow = join(workspace, ".autopilot", "skills", "ap-orchestration");
    await mkdir(shadow, { recursive: true });
    await mkdir(userDirectory);
    await writeFile(join(shadow, "SKILL.md"), "---\nname: ap-orchestration\ndescription: Fixture for same-name isolation\n---\nproject fixture");
    await bundledAdapters.createNodeTrustPolicy({ stateRoot: managedState }).grantTrust(await realpath(workspace));
    await host.start(join(app, ".webpack", "main", "orchestration-worker.cjs"), { execPath: node, execArgv: [], env: {
      AUTOPILOT_MANAGED_WORKSPACE: workspace, AUTOPILOT_MANAGED_STATE: managedState, NODE_OPTIONS: "", NODE_PATH: "",
      HOME: userDirectory, USERPROFILE: userDirectory, AGENT_WORKSPACE_ROOT: workspace,
    } });
    assert.equal(host.orchestrationTools, true);
    const created = await host.command({ operation: "create", requestId: randomUUID() }, true) as ManagedRuntimeReceipt;
    assert.equal(created.state, "confirmed");
    assert.ok(created.sessionId);
    /** 人类 CLI 操作沿用真正 Worker 的白名单及 Session 绑定。 */
    async function act(action: import("@autopilot-agent/cli/dist/types.js").CliAction) {
      return await host.command({ operation: "cli", requestId: randomUUID(), sessionId: created.sessionId, action }, true) as import("@autopilot-agent/cli/dist/controller.js").CliControllerResult;
    }
    const listed = await act({ type: "list_skills" });
    assert.ok(listed.skillOptions?.some(function builtin(entry) { return entry.qualifiedName === ORCHESTRATION_SKILL_ID; }));
    assert.ok(listed.skillOptions?.some(function local(entry) { return entry.qualifiedName === "repo:ap-orchestration"; }));
    assert.equal((await act({ type: "select_skill", skill: ORCHESTRATION_SKILL_ID })).kind, "ok");
    const prompt = await act({ type: "submit_prompt", content: "只准备输入，保持 Run 未启动。" });
    assert.deepEqual(prompt.preparedPrompt?.activeSkills, [{ skillId: ORCHESTRATION_SKILL_ID, contentHash: ORCHESTRATION_SKILL_HASH }]);
    const activity = await host.command({ operation: "inspect", requestId: randomUUID(), sessionId: created.sessionId }, true) as { turnId?: string };
    assert.equal(activity.turnId, undefined);
    process.stdout.write(JSON.stringify({ cli: cliMain, version: ORCHESTRATION_SKILL_VERSION, hash: ORCHESTRATION_SKILL_HASH, startedTurns: 0 }, null, 2) + "\n");
  } finally {
    host.stop();
    if (dirname(resolve(scratchRoot)) === resolve(tmpdir())) await rm(scratchRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

const appDirectory = process.argv[2];
if (!appDirectory) throw new Error("传入 Forge 产物内的 resources/app 目录。");
void verify(appDirectory).catch(function failed(error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
