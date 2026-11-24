// 只提取经 SRI 核验的固定原生资源，不安装 npm 包、不运行 postinstall 或驱动。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Parser } from "tar";

const version = "0.39.4";
const integrity = "R0ue5CWlpkGtbcXeq3ZKM96zLrCXkNKEGyttgWhi0eSNKoNSvxglvv1/D9NhKxe+MI+djiCFepPd4PYOM0H2Rg==";
const names = ["agent-browser-win32-x64.exe", "agent-browser-darwin-x64", "agent-browser-darwin-arm64", "LICENSE"];

/** 只读取明确的普通文件项，归档路径从不作为磁盘写入路径。 */
export async function prepareBrowserResources(resources: string, archive?: string): Promise<void> {
  let bytes: Buffer;
  if (archive) bytes = await readFile(archive);
  else {
    const response = await fetch(`https://registry.npmjs.org/agent-browser/-/agent-browser-${version}.tgz`, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error("浏览器资源下载失败。");
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) throw new Error("浏览器资源完整性校验失败。");
  const files = new Map<string, Buffer>();
  await new Promise<void>(function parse(resolve, reject) {
    const parser = new Parser({ onReadEntry: function entry(entry) {
      const name = names.find(function expected(name) { return entry.path === (name === "LICENSE" ? "package/LICENSE" : `package/bin/${name}`); });
      if (!name) { entry.resume(); return; }
      if (entry.type !== "File" || files.has(name) || entry.size > 64 * 1024 * 1024) { reject(new Error("浏览器资源格式无效。")); entry.resume(); return; }
      const chunks: Buffer[] = [];
      entry.on("data", function data(chunk) { chunks.push(Buffer.from(chunk)); });
      entry.on("end", function end() { files.set(name, Buffer.concat(chunks)); });
    } });
    parser.on("error", reject); parser.on("end", resolve); parser.end(bytes);
  });
  if (files.size !== names.length) throw new Error("浏览器资源缺失。");
  const destination = join(resources, "browser-driver", version);
  await mkdir(destination, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [name, data] of files) { await writeFile(join(destination, name), data, { mode: 0o755 }); hashes[name] = createHash("sha256").update(data).digest("hex"); }
  await writeFile(join(destination, "manifest.json"), JSON.stringify({ version, integrity: `sha512-${integrity}`, hashes }, null, 2));
}

/** 打包只复制匹配的平台资源，缺失/损坏即失败，不回退全局 PATH。 */
export async function copyBrowserResources(source: string, target: string, platform: string, arch: string): Promise<void> {
  const name = `agent-browser-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
  if (!names.includes(name)) throw new Error("不支持的浏览器驱动平台。");
  const root = join(source, "browser-driver", version);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.version !== version || manifest.integrity !== `sha512-${integrity}`) throw new Error("浏览器资源版本无效。");
  const destination = join(target, "browser-driver", version);
  await mkdir(destination, { recursive: true });
  for (const file of [name, "LICENSE"]) {
    if (createHash("sha256").update(await readFile(join(root, file))).digest("hex") !== manifest.hashes[file]) throw new Error("浏览器资源哈希校验失败。");
    await copyFile(join(root, file), join(destination, file));
    if (file !== "LICENSE" && platform === "darwin") await chmod(join(destination, file), 0o755);
  }
  await copyFile(join(root, "manifest.json"), join(destination, "manifest.json"));
}

if (require.main === module) prepareBrowserResources(resolve(__dirname, "../resources"), process.argv[2]).catch(function failed() { console.error("浏览器资源准备失败，请核对归档与网络。"); process.exitCode = 1; });
