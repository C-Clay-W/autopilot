// 固定资源静态打包检查只复制/散列文件，不执行任何平台驱动。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { copyBrowserResources } from "../scripts/browser-resources";
import { browserDriverPath } from "../src/browser-driver";

test("browser resources copy only selected platform and reject damaged binaries", async function resources() {
  const root = resolve(__dirname, "../../../.agent-tests/desktop-browser/tmp");
  const destination = await mkdtemp(join(root, "resources-"));
  const source = resolve(__dirname, "../resources");
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "x64"], ["darwin", "arm64"]] as const) {
    const target = join(destination, `${platform}-${arch}`);
    await copyBrowserResources(source, target, platform, arch);
    const executable = await browserDriverPath(target, platform, arch);
    assert.equal((await readdir(join(target, "browser-driver/0.39.4"))).length, 3);
    await writeFile(executable, "damaged fixture");
    await assert.rejects(browserDriverPath(target, platform, arch), /BROWSER_DRIVER_INTEGRITY_INVALID/);
  }
  await assert.rejects(copyBrowserResources(source, destination, "linux", "x64"), /不支持/);
});
