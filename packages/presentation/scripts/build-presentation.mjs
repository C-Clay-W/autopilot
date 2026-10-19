/** @autopilot-agent/presentation 构建入口：输出不打包 Core 的 ESM、CJS 与类型声明。 */
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(packageRoot, "src");
const distRoot = resolve(packageRoot, "dist");
const typesRoot = resolve(packageRoot, "dist-types");

/** 创建指定模块格式的打包配置，并显式保持 Core 为外部依赖。 */
function createBuildOptions(format, outfile) {
  return {
    entryPoints: [resolve(sourceRoot, "index.ts")],
    outfile: resolve(distRoot, outfile),
    bundle: true,
    platform: "node",
    format,
    external: ["@autopilot-agent/core", "node:*"],
    legalComments: "none",
  };
}

/** 生成公开 TypeScript 声明。 */
function buildTypes() {
  execFileSync("npx", ["tsc", "--emitDeclarationOnly", "--outDir", typesRoot], {
    cwd: packageRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/** 复制声明树到最终发布目录。 */
async function copyDeclarationTree() {
  for (const entry of await readdir(typesRoot, { withFileTypes: true })) {
    await cp(resolve(typesRoot, entry.name), resolve(distRoot, entry.name), { recursive: true, force: true });
  }
}

/** 清理旧产物后生成可发布的全部文件。 */
async function buildAll() {
  await rm(distRoot, { recursive: true, force: true });
  await rm(typesRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  buildTypes();
  await Promise.all([build(createBuildOptions("esm", "index.mjs")), build(createBuildOptions("cjs", "index.js"))]);
  await copyDeclarationTree();
  await rm(typesRoot, { recursive: true, force: true });
}

await buildAll();
