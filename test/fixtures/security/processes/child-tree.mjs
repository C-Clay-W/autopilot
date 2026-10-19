/** Stage 0 子进程树 fixture：启动保持存活的 Node 子进程并输出其 PID。 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const worker = new URL("./child-worker.mjs", import.meta.url);
const child = spawn(process.execPath, [fileURLToPath(worker)], { stdio: "ignore" });
const pidFile = process.argv[2];
if (pidFile) writeFileSync(pidFile, `${child.pid}\n`, "utf8");
process.stdout.write(`${child.pid}\n`);
setInterval(function keepParentAlive() {}, 1_000);
