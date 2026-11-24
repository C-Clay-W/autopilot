// CLI 真实源码入口回归：直接路径、workspace 联接和模块导入，不启动会话或 Provider。
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../..", import.meta.url));
const directEntry = resolve(root, "apps/cli/src/main.ts");
const linkedEntry = resolve(root, "node_modules/@autopilot-agent/cli/src/main.ts");

/** 仅运行帮助或模块导入，用真实 Node/tsx 验证入口判断。 */
function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: root, encoding: "utf8", timeout: 30000,
    env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: undefined },
  });
}

describe("CLI junction entry", function entryCases() {
  it.each([directEntry, linkedEntry])("入口 %s 输出帮助", function help(entry) {
    const result = run([entry, "--help"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  }, 30000);

  it("模块导入不执行 main", function imported() {
    const result = run(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(linkedEntry).href)}); console.log('IMPORT_ONLY');`, "--", "--help"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("IMPORT_ONLY");
  }, 30000);
});
