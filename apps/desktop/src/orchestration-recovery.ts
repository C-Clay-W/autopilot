/** 显式恢复的目录证据：只读当前内容摘要，不恢复进程或释放资源。 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
const execute = promisify(execFile);

/** Git 以 HEAD、完整差异及未跟踪内容为依据；非 Git 使用有界内容遍历，超界保留未知。 */
export async function checkoutEvidence(root: string): Promise<{ fingerprint?: string; reason?: string }> {
  const started = Date.now();
  let phase = "git", scanned = 0, read = 0;
  try {
    const signal = AbortSignal.timeout(30000);
    const hash = createHash("sha256"); let files: string[];
    try {
      const top = await execute("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"], { cwd: root, windowsHide: true, timeout: 5000 });
      const actual = resolve(top.stdout.trim()); const expected = resolve(root);
      if ((process.platform === "win32" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) throw new Error("CHECKOUT_NOT_GIT_ROOT");
      const head = await execute("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], { cwd: root, windowsHide: true, timeout: 5000 });
      const diff = await execute("git", ["-c", "core.fsmonitor=false", "diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"], { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
      const untracked = await execute("git", ["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
      hash.update(head.stdout).update(diff.stdout); files = untracked.stdout.split("\0").filter(Boolean);
    } catch {
      phase = "directory";
      files = [];
      /** 只遍历项目文件，不把运行账本、依赖和 Git 内部对象计入代码版本。 */
      async function visit(directory: string): Promise<void> {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          signal.throwIfAborted();
          if ([".git", "node_modules", ".autopilot", ".agent-tests"].includes(item.name)) continue;
          const file = join(directory, item.name);
          if (item.isSymbolicLink()) throw new Error("目录包含符号链接");
          if (item.isDirectory()) await visit(file); else files.push(relative(root, file));
          if (files.length > 4000) throw new Error("文件数量超过 4000 个");
        }
      }
      await visit(root);
    }
    phase = "content"; scanned = files.length;
    console.info("[orchestration-recovery]", { phase, scanned, elapsedMs: Date.now() - started });
    const sorted = files.sort();
    for (let offset = 0; offset < sorted.length; offset += 8) {
      // 小文件并行预读最多8MiB，消除数千次串行IO等待；摘要仍按旧顺序逐字节归约。
      const batch = await Promise.all(sorted.slice(offset, offset + 8).map(async function prepare(name) {
        signal.throwIfAborted();
        const file = resolve(root, name);
        if (relative(root, file).startsWith("..")) throw new Error("文件路径超出工作区");
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("目录包含符号链接或特殊文件");
        return { name, file, content: stat.size <= 1024 * 1024 ? await readFile(file, { signal }) : undefined };
      }));
      for (const item of batch) {
        signal.throwIfAborted();
        hash.update(item.name);
        if (item.content) hash.update(item.content);
        else for await (const chunk of createReadStream(item.file, { signal })) hash.update(chunk);
        read++;
      }
    }
    return { fingerprint: hash.digest("hex") };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    console.info("[orchestration-recovery]", { phase, scanned, read, elapsedMs: Date.now() - started, error: failure.name, code: failure.code });
    const reason = ["AbortError", "TimeoutError"].includes(failure.name) ? "目录读取超过 30 秒"
      : ["EACCES", "EPERM"].includes(failure.code ?? "") ? "没有目录或文件读取权限"
      : failure.code === "ENOENT" ? "读取时目录或文件不存在"
      : ["目录包含符号链接", "目录包含符号链接或特殊文件", "文件路径超出工作区", "文件数量超过 4000 个"].includes(failure.message) ? failure.message : "目录文件读取失败";
    return { reason };
  }
}
