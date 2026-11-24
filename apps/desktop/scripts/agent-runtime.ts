// Desktop 从既有共享源码生成纯 Agent 运行产物，只收集实际外部依赖，隔离知识库和文档后端。
import { build, type Metafile } from "esbuild";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const repository = resolve(__dirname, "../../..");
const forbiddenPackages = /^(?:@lancedb\/|@huggingface\/|onnxruntime-|pdf-parse$|pdfjs-dist$|xlsx$|mammoth$|mysql2$|sql\.js$|sharp$)/;
const forbiddenModules = /(?:internal\/(?:agent-flow|database-snapshot|database-search|knowledge-resource-store|rag-error)|internal\/lib\/(?:vector-store|document-parser|pdf-processor|excel-parser)|node\/(?:rag\/|create-node-chat|stores\/node-chat))/;

/** Desktop 主进程与独立 CLI 只需要这几个运行根，前端依赖已经进入 renderer bundle。 */
export function desktopRuntimeDependencies(manifest: { dependencies: Record<string, string> }): Record<string, string> {
  const names = ["@autopilot-agent/cli", "@autopilot-agent/core", "@autopilot-agent/adapters", "@autopilot-agent/presentation", "node-pty"];
  return Object.fromEntries(names.map(function dependency(name) { return [name, manifest.dependencies[name]]; }));
}

/** 从调用包向上解析实际安装目录，保留 npm 嵌套依赖的版本身份。 */
export async function findPackage(name: string, from: string): Promise<string | undefined> {
  let directory = from;
  while (true) {
    const candidate = join(directory, "node_modules", name);
    try { await stat(join(candidate, "package.json")); return await realpath(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** 只复用公开入口的直接转导出，避免完整入口顶层加载 RAG；编译时校验消费者需要的导出。 */
async function agentEntry(source: string): Promise<string> {
  const contents = await readFile(source, "utf8");
  const file = ts.createSourceFile(source, contents, ts.ScriptTarget.Latest, true);
  return file.statements.filter(function agentExport(statement) {
    return ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
      && !forbiddenModules.test((statement.moduleSpecifier as ts.StringLiteral).text);
  }).map(function statementText(statement) { return statement.getText(file); }).join("\n");
}

/** 从构建器输出提取真实运行依赖，子路径归并到包名，拒绝知识库依赖进入产物。 */
function externalPackages(metafile: Metafile): Set<string> {
  const names = new Set<string>();
  for (const output of Object.values(metafile.outputs)) for (const imported of output.imports) {
    if (!imported.external || isBuiltin(imported.path)) continue;
    const parts = imported.path.split("/");
    const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (forbiddenPackages.test(name)) throw new Error(`Desktop forbidden dependency: ${name}`);
    names.add(name);
  }
  for (const input of Object.keys(metafile.inputs)) {
    if (forbiddenModules.test(input.replaceAll("\\", "/"))) throw new Error(`Desktop forbidden source: ${input}`);
  }
  return names;
}

/** 为纯 Agent 构建保留准确依赖版本，动态原生资源通过显式清单补充。 */
async function dependencyVersions(names: Iterable<string>, sourceRoot: string): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {};
  for (const name of names) {
    const source = await findPackage(name, sourceRoot);
    if (!source) throw new Error(`Missing Desktop Agent dependency: ${name}`);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    dependencies[name] = manifest.version;
  }
  return dependencies;
}

/** 在仓库独占暂存根构建，避免改写 CLI/Web 共用的 dist 和公开 package.json。 */
export async function buildAgentRuntime(platform: string, arch: string): Promise<{ root: string; sources: Map<string, string> }> {
  await mkdir(join(repository, ".local"), { recursive: true });
  const profile = await mkdtemp(join(repository, ".local", `desktop-agent-${platform}-${arch}-`));
  const sources = new Map<string, string>();
  for (const packageName of ["core", "adapters", "presentation", "cli"]) {
    const sourceRoot = join(repository, packageName === "cli" ? "apps" : "packages", packageName);
    const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    const target = join(profile, "node_modules", manifest.name);
    sources.set(target, sourceRoot);
    await mkdir(join(target, "dist"), { recursive: true });
    const entry = join(sourceRoot, "src", packageName === "cli" ? "main.ts" : "index.ts");
    const names = new Set<string>();
    for (const format of packageName === "cli" ? ["esm"] as const : ["cjs", "esm"] as const) {
      const result = await build({
        ...(packageName === "cli"
          ? { entryPoints: { main: entry, "composition-root": join(sourceRoot, "src", "composition-root.ts"), controller: join(sourceRoot, "src", "controller.ts") }, outdir: join(target, "dist"), splitting: true }
          : { outfile: join(target, "dist", format === "cjs" ? "index.js" : "index.mjs"), ...(packageName === "core" || packageName === "adapters"
          ? { stdin: { contents: await agentEntry(entry), resolveDir: dirname(entry), loader: "ts", sourcefile: `${packageName}-agent.ts` } }
          : { entryPoints: [entry] }) }),
        bundle: true, platform: "node", format, packages: "external", minify: true, metafile: true, legalComments: "none",
        define: { "process.platform": JSON.stringify(platform), "process.arch": JSON.stringify(arch) },
      });
      for (const name of externalPackages(result.metafile!)) names.add(name);
      if (packageName === "core") for (const subpath of ["ui", "failure"]) {
        const subpathResult = await build({
          entryPoints: [join(sourceRoot, "src", subpath === "ui" ? "ui/index.ts" : "failure.ts")],
          outfile: join(target, "dist", subpath, format === "cjs" ? "index.js" : "index.mjs"),
          bundle: true, platform: "node", format, packages: "external", minify: true, metafile: true, legalComments: "none",
        });
        for (const name of externalPackages(subpathResult.metafile!)) names.add(name);
      }
    }
    // 这两项通过动态 require 读取原生资源，macOS 的 SRT 也由非字面量 import 加载。
    if (packageName === "core") { names.add("@napi-rs/canvas"); names.add("@vscode/ripgrep"); }
    if (packageName === "adapters" && platform === "darwin") names.add("@anthropic-ai/sandbox-runtime");
    const runtimeManifest: Record<string, unknown> = {
      name: manifest.name,
      version: manifest.version,
      main: packageName === "cli" ? "dist/main.js" : "dist/index.js",
      dependencies: await dependencyVersions(names, sourceRoot),
    };
    if (packageName === "cli") {
      runtimeManifest.type = "module";
      runtimeManifest.bin = manifest.bin;
    } else {
      const exports: Record<string, unknown> = {
        ".": { import: "./dist/index.mjs", require: "./dist/index.js" },
        "./package.json": "./package.json",
      };
      if (packageName === "core") for (const subpath of ["ui", "failure"]) {
        exports[`./${subpath}`] = { import: `./dist/${subpath}/index.mjs`, require: `./dist/${subpath}/index.js` };
      }
      runtimeManifest.exports = exports;
    }
    await writeFile(join(target, "package.json"), JSON.stringify(runtimeManifest, null, 2));
  }
  const desktop = JSON.parse(await readFile(join(repository, "apps/desktop/package.json"), "utf8"));
  await writeFile(join(profile, "package.json"), JSON.stringify({ dependencies: desktopRuntimeDependencies(desktop) }, null, 2));
  return { root: profile, sources };
}
