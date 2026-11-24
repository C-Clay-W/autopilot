/** Desktop 独立 AP Worker：Trust 后复用 Core bootstrap、Node 配置与能力装配。 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { projectRuntimeFact } from "@autopilot-agent/core";
import { createNodeTrustPolicy, initializeNodeStateRoot, withNodeRuntimeOwner } from "@autopilot-agent/adapters";
import { serveManagedRuntime } from "./managed-runtime-worker";
import { createOrchestrationToolLoader } from "./orchestration-tools";
import type { ManagedRuntimeIdentity } from "./managed-runtime-service";
import { withOrchestrationSkill } from "./orchestration-skill";

/** 仅父进程传入目录和身份；页面不能指定 Provider、凭据或 Worker。 */
async function main(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("MANAGED_PRIVATE_CHANNEL_REQUIRED");
  const workspaceRoot = await realpath(process.env.AUTOPILOT_MANAGED_WORKSPACE!);
  const stateRoot = process.env.AUTOPILOT_MANAGED_STATE!;
  const identity = JSON.parse(process.env.AUTOPILOT_MANAGED_IDENTITY!) as ManagedRuntimeIdentity;
  // 共享 Worker 的浏览器只能用按 Run 绑定的 IPC；不继承任何终端或第三方连接凭据。
  for (const key of ["AUTOPILOT_BROWSER_ENDPOINT", "AUTOPILOT_BROWSER_NATIVE_TOKEN", "AUTOPILOT_BROWSER_AGENT_TOKEN", "AUTOPILOT_BROWSER_CALLER_TOKEN"]) delete process.env[key];
  const trustPolicy = createNodeTrustPolicy({ stateRoot });
  // Trust 前不读取项目配置，不初始化持久会话。
  if ((await trustPolicy.getTrustStatus(workspaceRoot)).status !== "trusted") throw new Error("ORCHESTRATION_TRUST_REQUIRED");
  // owner 锁放在同级宿主目录，避免新 Core 状态根被锁文件误判成未知旧 schema。
  await withNodeRuntimeOwner(join(dirname(stateRoot), basename(stateRoot) + "-owner"), async function own() {
    for (const directory of [join(workspaceRoot, ".autopilot"), join(workspaceRoot, ".autopilot", "tmp")]) {
      await mkdir(directory, { recursive: true });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MANAGED_TEMP_UNSAFE");
    }
    initializeNodeStateRoot(stateRoot);
    // 原生ESM加载固定发布入口，避免Webpack复制CLI/Core或改写模块路径。
    const cliRequire = createRequire(__filename);
    const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@autopilot-agent/cli/dist/composition-root.js")>;
    const { createCliCompositionRoot } = await load(pathToFileURL(cliRequire.resolve("@autopilot-agent/cli/dist/composition-root.js")).href);
    let ports: import("@autopilot-agent/core").RuntimePorts | undefined;
    const root = createCliCompositionRoot({ stateRoot, workspaceRoot, trustPolicy, enableUserQuestions: true,
      decorateSkills: withOrchestrationSkill,
      defaultRunConfig: { hostToolsLoader: createOrchestrationToolLoader(identity) },
      decoratePorts: function observe(runtimePorts) {
        const sink = runtimePorts.eventSink;
        ports = { ...runtimePorts, eventSink: { async write(envelope) { await sink.write(envelope); if (process.connected && projectRuntimeFact(envelope)) process.send?.({ kind: "changed", ...identity, sessionId: envelope.sessionId }); } } };
        return ports;
      },
    });
    const runtime = await root.createRuntime(workspaceRoot);
    const loadController = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@autopilot-agent/cli/dist/controller.js")>;
    const { createCliController } = await loadController(pathToFileURL(cliRequire.resolve("@autopilot-agent/cli/dist/controller.js")).href);
    await serveManagedRuntime(runtime, { identity, workspaceRoot, journalPath: join(stateRoot, "managed-commands.json"), orchestration: true, ports: ports!, cli: { root, createCliController } });
  });
}

void main().then(function exit() { process.exit(0); }).catch(function failed(error) {
  const code = error?.code ?? (error instanceof Error ? error.message : "");
  const identity = JSON.parse(process.env.AUTOPILOT_MANAGED_IDENTITY ?? "{}");
  if (process.connected) process.send?.({ kind: "startup_error", ...identity, error: typeof code === "string" && /^[A-Z][A-Z_]{1,80}$/.test(code) ? code : "MANAGED_BOOTSTRAP_FAILED" }, function sent() { process.exit(1); });
  else process.exit(1);
});
