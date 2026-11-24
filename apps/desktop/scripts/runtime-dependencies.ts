// 为 Forge Webpack external 收集已安装的生产依赖，保留共享发布产物和原生资产。
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { buildAgentRuntime, desktopRuntimeDependencies, findPackage } from "./agent-runtime";
import { copyBrowserResources } from "./browser-resources";

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[];
  cpu?: string[];
}

/** 按 npm 平台字段筛选可选原生包。 */
function supportsPlatform(values: string[] | undefined, value: string): boolean {
  return !values || (!values.includes(`!${value}`) && (values.every(function isNegative(item) { return item.startsWith("!"); }) || values.includes(value)));
}

/** 收集生产闭包，同一真实包复用顶层，版本冲突使用嵌套布局。 */
export async function collectRuntimeDependencies(sourceRoot: string, targetRoot: string, platform: string, arch: string, sources = new Map<string, string>()): Promise<void> {
  const rootPackages = new Map<string, string>();
  const copied = new Map<string, string>();

  /** 递归复制必需与平台适用的可选依赖，必需包缺失立即失败。 */
  async function copyPackage(name: string, from: string, parentTarget: string, optional = false): Promise<void> {
    const candidate = join(sourceRoot, "node_modules", name);
    const source = sources.has(candidate) ? candidate : await findPackage(name, sources.get(from) ?? from);
    if (!source) {
      if (optional) return;
      throw new Error(`Missing desktop runtime dependency: ${name}`);
    }
    const manifest: PackageManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (!supportsPlatform(manifest.os, platform) || !supportsPlatform(manifest.cpu, arch)) {
      if (optional) return;
      throw new Error(`Unsupported desktop runtime dependency: ${name} (${platform}/${arch})`);
    }
    // 已复制的祖先依赖可直接通过 Node 解析复用，也能终止循环依赖。
    let ancestor = parentTarget;
    let shadowed = false;
    while (ancestor.startsWith(targetRoot)) {
      const installed = copied.get(join(ancestor, "node_modules", name));
      if (installed) {
        if (installed === source) return;
        shadowed = true;
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const previousSource = rootPackages.get(name);
    const destination = join(shadowed || (previousSource && previousSource !== source) ? parentTarget : targetRoot, "node_modules", name);
    if (copied.get(destination) === source) return;
    copied.set(destination, source);
    if (!previousSource) rootPackages.set(name, source);
    await mkdir(dirname(destination), { recursive: true });
    const shared = name.startsWith("@autopilot-agent/");
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      /** 共享包只携带 dist 与清单，第三方包保留资产并单独收集依赖。 */
      filter: function includeRuntimeFile(path) {
        if (path === source) return true;
        if (["node_modules", ".git", ".cache"].includes(basename(path))) return false;
        if (/\.(?:map|pdb|ts|tsx)$/.test(path)) return false;
        const relative = path.slice(source.length + 1).split(sep);
        if (["test", "tests", "__tests__", "examples", "docs"].includes(relative[0])) return false;
        if (name === "node-pty") {
          if (relative[0] === "prebuilds") return relative.length === 1 || relative[1] === `${platform}-${arch}`;
          if (relative[0] === "build") return false;
          return relative[0] === "lib" || relative.length === 1 && !["src", "deps", "third_party", "scripts"].includes(relative[0]);
        }
        if (name === "@anthropic-ai/sandbox-runtime" && relative[0] === "vendor") {
          if (relative[1] === "srt-win" && platform !== "win32" || relative[1] === "seccomp" && platform !== "linux") return false;
        }
        return !shared || path === join(source, "package.json") || path === join(source, "dist") || path.startsWith(join(source, "dist") + sep);
      },
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!(dependency in (manifest.optionalDependencies ?? {}))) await copyPackage(dependency, source, destination);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await copyPackage(dependency, source, destination, true);
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      await copyPackage(dependency, source, destination, manifest.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  }

  const manifest: PackageManifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies ?? {})) await copyPackage(name, sourceRoot, targetRoot);
}

/** 补齐 external 依赖后交由 Forge 官方 rebuild 与目录打包流程处理。 */
export async function copyRuntimeDependencies(_config: unknown, buildPath: string, _electronVersion: string, platform: string, arch: string): Promise<void> {
  const profile = await buildAgentRuntime(platform, arch);
  await collectRuntimeDependencies(profile.root, buildPath, platform, arch, profile.sources);
  if (platform !== "win32" && platform !== "darwin") throw new Error("Desktop packaging supports Windows and macOS");
  // 只分发目标平台的 N-API 和 helper，不携带构建机的 build/Release。
  const prebuilds = join(buildPath, "node_modules/node-pty/prebuilds", `${platform}-${arch}`);
  const nativeFiles = platform === "win32" ? ["conpty.node", "conpty_console_list.node"] : ["pty.node", "spawn-helper"];
  await Promise.all(nativeFiles.map(function checkNative(file) { return access(join(prebuilds, file)); }));
  const runtimeName = platform === "win32" ? "node-windows-20.20.2" : `node-darwin-${arch}-20.20.2`;
  const runtime = resolve(__dirname, "../../../.local", runtimeName, "package");
  const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  if (manifest.version !== "20.20.2" || !manifest.cpu?.includes(arch) || !manifest.os?.includes(platform)) throw new Error("Desktop 打包需要与目标平台和架构匹配的 Node 20.20.2，请按 BUILD.md 准备运行时。");
  // buildPath 是暂存 resources/app；Mac 沿用 node20/bin/node，Windows 使用 node20/node.exe。
  const destination = join(dirname(buildPath), "node20", ...(platform === "darwin" ? ["bin"] : []));
  await cp(join(runtime, "bin"), destination, { recursive: true });
  await copyBrowserResources(resolve(__dirname, "../resources"), dirname(buildPath), platform, arch);
}

/** Forge 先在 afterCopy 写入清单，在 afterPrune 将清单同步为实际分发的运行依赖。 */
export async function finalizeRuntimeManifest(_config: unknown, buildPath: string): Promise<void> {
  const file = join(buildPath, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...manifest, dependencies: desktopRuntimeDependencies(manifest) }, null, 2));
}
