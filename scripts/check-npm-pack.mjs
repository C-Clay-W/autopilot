/** 核对五个 CLI 发布包的实际 npm 清单；不构建、不发布、不修改开发源码。 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packagePaths = ["packages/core", "packages/adapters", "packages/presentation", "apps/cli", "packages/autopilot-agent"];
const packages = process.argv.length > 2 ? process.argv.slice(2) : packagePaths;
for (const packagePath of packages) {
  if (!packagePaths.includes(packagePath)) throw new Error(`未知发布包 ${packagePath}`);
}
const releaseVersion = JSON.parse(readFileSync(resolve(repositoryRoot, "packages/autopilot-agent/package.json"), "utf8")).version;
const lock = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"));
for (const packagePath of ["", ...packagePaths, "apps/web"]) {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, packagePath, "package.json"), "utf8"));
  if (manifest.version !== releaseVersion) throw new Error(`${manifest.name}: 仓库版本不一致`);
  if (lock.packages[packagePath]?.version !== releaseVersion) throw new Error(`${manifest.name}: 锁文件版本不一致`);
  for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    if (name.startsWith("@autopilot-agent/") && version !== releaseVersion) throw new Error(`${manifest.name}: 内部依赖版本不一致 ${name}`);
    if (lock.packages[packagePath]?.dependencies?.[name] !== version) throw new Error(`${manifest.name}: 锁文件依赖不一致 ${name}`);
  }
  if ((packagePath === "" || packagePath === "apps/web") && manifest.private !== true) throw new Error(`${manifest.name}: 必须保持 private`);
}
if (lock.version !== releaseVersion) throw new Error("根锁文件版本不一致");
const cliConstants = readFileSync(resolve(repositoryRoot, "apps/cli/src/tui/constants.ts"), "utf8");
if (cliConstants.match(/AUTOPILOT_VERSION\s*=\s*"([^"]+)"/)?.[1] !== releaseVersion) throw new Error("CLI 展示版本不一致");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("请通过 npm run check:npm-pack 执行清单检查。");

/** 读取实际打包清单，拒绝测试、源码映射、私有目录或缺失入口。 */
function checkPackage(packagePath) {
  const directory = resolve(repositoryRoot, packagePath);
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const exclusions = readFileSync(resolve(directory, ".npmignore"), "utf8").split(/\r?\n/).map(function trim(line) { return line.trim(); }).filter(function isPattern(line) { return line && !line.startsWith("#"); });
  for (const pattern of exclusions) {
    if (!manifest.files?.includes(`!${pattern}`)) throw new Error(`${manifest.name}: files 未同步 .npmignore 排除项 ${pattern}`);
  }
  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${manifest.name}: ${result.stderr || result.stdout}`);
  const [pack] = JSON.parse(result.stdout);
  const files = new Set(pack.files.map(function (file) { return file.path; }));
  const forbiddenDirectories = /(^|\/)(agent|agents|test|tests|test-[^/]*|__tests__|__mocks__|contract-test|fixtures|coverage|playwright-report|test-results|src|dist-types|node_modules|\.agent-tests|\.agents|\.codex|\.cursor|\.idea|\.vscode|\.git|\.hg|\.svn|\.github|\.gitlab|\.local|\.autopilot|\.cache|\.npm-cache|\.turbo|\.next|\.vite|__pycache__)(\/|$)/i;
  const forbiddenFiles = /\.(test|spec|bench)\.|-fixture[^/]*\.|\.(map|log|tsbuildinfo|tmp|temp|bak|orig|rej|swp|swo|pyc|pyo|tgz|tar|zip|7z|rar|db|sqlite|sqlite3|wal|shm|pem|key|p12|pfx|crt|cer)$/i;
  const privateNames = /^(?:\.env.*|\.npmrc.*|\.yarnrc.*|\.pnp\..*|AGENTS\.md|CLAUDE\.md|\.DS_Store|Thumbs\.db|settings(?:\.local)?\.json|mcp\.json|credentials(?:\.local)?\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|tsconfig.*|(?:vitest|vite|playwright|eslint|jest)\.config\..*|turbo\.json)$/i;
  for (const file of files) {
    if (forbiddenDirectories.test(file) || forbiddenFiles.test(file) || privateNames.test(posix.basename(file))) throw new Error(`${manifest.name}: 禁止发布 ${file}`);
    const allowed = file === "package.json" || file === "README.md" || /^LICEN[CS]E(?:\..*)?$/i.test(file) ||
      (packagePath === "packages/autopilot-agent"
        ? ["bin/autopilot-agent.mjs", "schema/cc-compatible-settings.schema.json"].includes(file)
        : /^dist\/.*\.(?:js|mjs|d\.ts)$/.test(file) || (packagePath === "packages/core" && file === "dist/scripts/pdf_extract.py"));
    if (!allowed) throw new Error(`${manifest.name}: 不在发布白名单 ${file}`);
    if (/\.(?:js|mjs|d\.ts)$/.test(file) && /^\s*(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/m.test(readFileSync(resolve(directory, file), "utf8"))) {
      throw new Error(`${manifest.name}: 禁止发布源码映射指令 ${file}`);
    }
  }
  const required = ["README.md", "package.json", ...Object.values(manifest.bin || {}), manifest.main, manifest.module, manifest.types];
  for (const exported of Object.values(manifest.exports || {})) {
    if (typeof exported === "string") required.push(exported);
    else required.push(...Object.values(exported));
  }
  for (const file of required.filter(Boolean)) {
    if (!files.has(file.replace(/^\.\//, ""))) throw new Error(`${manifest.name}: 缺少入口 ${file}`);
  }
  for (const file of files) {
    if (!file.endsWith(".d.ts")) continue;
    const source = ts.preProcessFile(readFileSync(resolve(directory, file), "utf8"));
    for (const imported of source.importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), imported.fileName)).replace(/\.(?:m?js)$/, "");
      if (![target, `${target}.d.ts`, `${target}/index.d.ts`].some(function (candidate) { return files.has(candidate); })) {
        throw new Error(`${manifest.name}: 声明引用未发布文件 ${file} -> ${imported.fileName}`);
      }
    }
  }
  if (manifest.version !== releaseVersion) throw new Error(`${manifest.name}: 与入口包版本不一致`);
  for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    if (name.startsWith("@autopilot-agent/") && version !== releaseVersion) throw new Error(`${manifest.name}: 内部依赖版本不一致 ${name}`);
  }
  console.log(`${manifest.name}@${manifest.version}: PASS (${files.size} files)`);
}

for (const packagePath of packages) checkPackage(packagePath);
