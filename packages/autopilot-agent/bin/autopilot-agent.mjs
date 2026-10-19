#!/usr/bin/env node
/**
 * 无 scope 用户入口；只解析已安装的 CLI 包并转发参数，不复制 Runtime 或状态逻辑。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** 根据 CLI 公共入口定位同包内的实际 dist/main.js 启动文件。 */
function resolveCliMainPath() {
  const cliEntryPath = require.resolve("@autopilot-agent/cli");
  return join(dirname(cliEntryPath), "main.js");
}

/** 使用当前 Node 进程同步转发 CLI，保留 stdout/stderr、退出码和信号语义。 */
function runCli() {
  const result = spawnSync(process.execPath, [resolveCliMainPath(), ...process.argv.slice(2)], {
    stdio: "inherit",
    windowsHide: false,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}

runCli();
