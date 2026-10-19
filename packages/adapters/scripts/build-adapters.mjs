/**
 * @autopilot-agent/adapters 构建入口：生成共享 Node Adapter 的 ESM/CJS 产物和声明文件。
 */
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(packageRoot, "src");
const distRoot = resolve(packageRoot, "dist");
const typesRoot = resolve(packageRoot, "dist-types");

/** 为共享包构造不打包 Core、SRT 和 Node 内置模块的 esbuild 配置。 */
function createBuildOptions(format, outfile) {
  return {
    entryPoints: [resolve(sourceRoot, "index.ts")],
    outfile: resolve(distRoot, outfile),
    bundle: true,
    platform: "node",
    format,
    // SRT 是 ESM-only 包且自带平台二进制资产，必须保持运行时依赖；
    // sandbox adapter 用非字面量动态 import 加载，避免 CJS 产物中出现 require(ESM)。
    external: ["@autopilot-agent/core", "@anthropic-ai/sandbox-runtime", "node:*"],
    legalComments: "none",
  };
}

/** 生成 TypeScript 声明文件。 */
function buildTypes() {
  execFileSync("npx", ["tsc", "--emitDeclarationOnly", "--outDir", typesRoot], {
    cwd: packageRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/** 将声明文件树复制到发布目录。 */
async function copyDeclarationTree() {
  for (const entry of await readdir(typesRoot, { withFileTypes: true })) {
    await cp(resolve(typesRoot, entry.name), resolve(distRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

/** 构建共享 Adapter 的全部发布产物。 */
async function buildAll() {
  await rm(distRoot, { recursive: true, force: true });
  await rm(typesRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  buildTypes();
  await Promise.all([
    build(createBuildOptions("esm", "index.mjs")),
    build(createBuildOptions("cjs", "index.js")),
  ]);
  await copyDeclarationTree();
  await rm(typesRoot, { recursive: true, force: true });
}

await buildAll();
