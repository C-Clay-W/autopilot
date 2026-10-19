/**
 * core 构建入口：集中生成公共入口与动态加载所需的独立内部模块，并同步类型声明。
 */
import { build, context } from "esbuild";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const coreRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(coreRoot, "src");
const distRoot = resolve(coreRoot, "dist");
const typesRoot = resolve(coreRoot, "dist-types");
const isWatch = process.argv.includes("--watch");
const isDev = process.argv.includes("--dev");

const internalEntries = [
  ["internal/lib/document-parser.ts", "internal/lib/document-parser.js", ["xlsx", "mammoth", "pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "node:*"]],
  ["internal/lib/excel-parser.ts", "internal/lib/excel-parser.js", ["xlsx", "node:*"]],
  ["internal/lib/embeddings.ts", "internal/lib/embeddings.js", []],
  ["internal/lib/vector-store.ts", "internal/lib/vector-store.js", ["@lancedb/*", "node:*"]],
  ["internal/lib/chunk.ts", "internal/lib/chunk.js", []],
  ["internal/lib/llm.ts", "internal/lib/llm.js", []],
  ["internal/lib/file-storage.ts", "internal/lib/file-storage.js", ["node:*"]],
  ["internal/lib/pdf-processor.ts", "internal/lib/pdf-processor.js", ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "node:*"]],
];

/** 构造保持旧产物布局的 esbuild 配置，避免破坏动态 require。 */
function createBuildOptions(entryPoint, outfile, format, external = []) {
  return {
    entryPoints: [resolve(sourceRoot, entryPoint)],
    outfile: resolve(distRoot, outfile),
    bundle: true,
    platform: "node",
    format,
    minify: !isDev,
    legalComments: "none",
    external,
  };
}

/** 生成声明文件并将入口声明放入可发布的 dist 目录。 */
function buildTypes() {
  execFileSync("npx", ["tsc", "--emitDeclarationOnly", "--outDir", typesRoot], {
    cwd: coreRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/**
 * 将 dist-types 中的全部 .d.ts 复制到 dist，保留目录结构。
 * 入口 index.d.ts 会 re-export ./runtime/* 与 ./internal/* 等子路径声明，
 * 因此必须一并复制，否则消费者 IDE 会因找不到子模块声明而报类型错误。
 */
async function copyDeclarationTree() {
  for (const entry of await readdir(typesRoot, { withFileTypes: true })) {
    await cp(resolve(typesRoot, entry.name), resolve(distRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

/** 在内存中清理生成 JavaScript 的行尾空白后一次写入，避免 Windows 上立即覆盖新产物。 */
async function writeGeneratedJavaScript(outputFile) {
  const cleaned = outputFile.text.replace(/[ \t]+(?=\r?\n|$)/g, "");
  await mkdir(dirname(outputFile.path), { recursive: true });
  await writeFile(outputFile.path, cleaned, "utf8");
}

/** 一次性构建所有公共和动态加载入口。 */
async function buildAll() {
  await rm(distRoot, { recursive: true, force: true });
  await rm(typesRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  buildTypes();

  const entries = [
    createBuildOptions("index.ts", "index.mjs", "esm", ["@lancedb/*", "mysql2/*"]),
    createBuildOptions("index.ts", "index.js", "cjs", ["@lancedb/*", "mysql2/*"]),
    createBuildOptions("experimental/index.ts", "experimental/index.mjs", "esm", ["@lancedb/*", "mysql2/*"]),
    createBuildOptions("experimental/index.ts", "experimental/index.js", "cjs", ["@lancedb/*", "mysql2/*"]),
    createBuildOptions("lancedb-cli.ts", "lancedb-cli.js", "cjs", ["@lancedb/*"]),
    ...internalEntries.map(([entryPoint, outfile, external]) => createBuildOptions(entryPoint, outfile, "cjs", external)),
  ];
  const results = await Promise.all(entries.map(function buildGeneratedEntry(options) {
    return build({ ...options, write: false });
  }));
  await Promise.all(results.flatMap(function getGeneratedFiles(result) {
    return result.outputFiles.map(writeGeneratedJavaScript);
  }));
  await copyDeclarationTree();
  await mkdir(resolve(distRoot, "scripts"), { recursive: true });
  await cp(resolve(coreRoot, "scripts/pdf_extract.py"), resolve(distRoot, "scripts/pdf_extract.py"), { force: true });
}

/** 监听模式只监控入口构建；类型声明由显式 build/typecheck 更新。 */
async function watchAll() {
  await buildAll();
  const entries = [
    createBuildOptions("index.ts", "index.mjs", "esm", ["@lancedb/*"]),
    createBuildOptions("index.ts", "index.js", "cjs", ["@lancedb/*"]),
  ];
  await Promise.all(entries.map(async (options) => {
    const buildContext = await context(options);
    await buildContext.watch();
  }));
}

if (isWatch) {
  await watchAll();
} else {
  await buildAll();
}
