/** 受管 Host 的原子 JSON 记录；先同步临时文件再替换，失败保留原记录。 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const accesses = new Map<string, Promise<unknown>>();

/** 同进程读句柄与替换串行，避免 Windows 高频观察饿死 rename；跨进程写锁仍由调用方负责。 */
async function accessRecord<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = accesses.get(path) ?? Promise.resolve();
  const next = previous.catch(function continueAfterFailure() {}).then(operation);
  accesses.set(path, next);
  try { return await next; }
  finally { if (accesses.get(path) === next) accesses.delete(path); }
}

/** 缺文件才返回初值，损坏和权限错误不能伪装成空状态。 */
export async function readManagedRecord<T>(path: string, initial: T): Promise<T> {
  try { return await accessRecord(path, async function read() { return JSON.parse(await readFile(path, "utf8")) as T; }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial; throw error; }
}

/** 同一文件由所属 Host 串行调用；不跨进程共享可变对象。 */
export async function writeManagedRecord(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  // Windows 并发只读句柄可能短暂拒绝替换；仅重试同一已同步临时文件，不重放业务操作。
  await accessRecord(path, async function replace() { for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, path); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await setTimeout(20 * (attempt + 1));
    }
  } });
}
