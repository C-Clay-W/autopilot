/**
 * Node Skill capability loader：扫描受控 roots，冻结 canonical Skill 身份和 contentHash。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import type {
  AgentSkillsCapability,
  LoadedSkill,
  PreparedSkillCommand,
  SkillCatalogEntry,
  SkillDiscoveryCandidate,
  SkillResource,
} from "@autopilot-agent/core";
import type { NodeCapabilityLoaderOptions } from "../types";

type SkillSource = "repo" | "user" | "claude";
interface DiscoveredSkill extends SkillCatalogEntry { root: string; skillPath: string; skillDirectory: string; }
const MAX_SKILLS = 100;
const MAX_SKILL_BODY = 48_000;
const MAX_RESOURCE_BYTES = 128 * 1024;

/** 解析完整 YAML frontmatter；格式能力与 Claude Code Skill 文件保持一致。 */
function parseSkillFrontmatter(frontmatter: string): Record<string, unknown> | undefined {
  try {
    const parsed = loadYaml(frontmatter);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** 读取 YAML 中的字符串字段，忽略不符合字段类型的值。 */
function readSkillString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 读取 Claude Code 接受的布尔字段写法。 */
function readSkillBoolean(fields: Record<string, unknown>, key: string): boolean | undefined {
  const value = fields[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  return undefined;
}

/** 读取 YAML 列表或逗号分隔工具名，保留含空格的单条工具规则。 */
function readSkillTools(fields: Record<string, unknown>): string[] | undefined {
  const value = fields["allowed-tools"];
  if (Array.isArray(value) && value.every(function isToolName(item) { return typeof item === "string" && item.trim(); })) {
    return value.map(function trimTool(item) { return (item as string).trim(); });
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const tools = value.includes(",") ? value.split(",") : /^[\w-]+(?:\s+[\w-]+)*$/u.test(value) ? value.split(/\s+/u) : [value];
  return tools.map(function trimTool(item) { return item.trim(); }).filter(Boolean);
}

/** 在 description 省略时取得 Markdown 的首个非空段落，遵循 Claude Code 的回退规则。 */
function readSkillDescription(fields: Record<string, unknown>, markdown: string): string | undefined {
  const explicit = readSkillString(fields, "description");
  const whenToUse = readSkillString(fields, "when_to_use") ?? readSkillString(fields, "when-to-use");
  const description = explicit ?? markdown.trim().split(/\r?\n\s*\r?\n/u).find(function firstParagraph(paragraph) { return paragraph.trim(); })?.trim();
  if (!description) return undefined;
  return [description, whenToUse].filter(Boolean).join("\n").slice(0, 1536);
}

/** 校验资源路径保持在指定 Skill 目录内。 */
function resolveContained(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error("Skill 资源路径必须是根目录内的相对路径");
  const resolved = path.resolve(root, relativePath);
  const canonicalRoot = fs.realpathSync.native(root);
  const canonical = fs.realpathSync.native(resolved);
  const relative = path.relative(canonicalRoot, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Skill 资源越出声明根目录");
  return canonical;
}

/** 解析 Claude Code 风格 Skill；目录名提供调用身份，frontmatter 只提供展示和元数据。 */
function parseSkill(filePath: string, source: SkillSource, root: string): DiscoveredSkill | undefined {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_SKILL_BODY) return undefined;
  const content = fs.readFileSync(filePath, "utf8");
  const match = /^---\r?\n([\s\S]{0,4096}?)\r?\n---\r?\n/.exec(content);
  if (!match) return undefined;
  const fields = parseSkillFrontmatter(match[1]);
  if (!fields) return undefined;
  const name = path.basename(path.dirname(filePath));
  const description = readSkillDescription(fields, content.slice(match[0].length));
  if (!/^[a-z0-9-]{1,64}$/.test(name) || !description) return undefined;
  const declaredName = readSkillString(fields, "name");
  const displayName = declaredName && declaredName.length <= 64 ? declaredName : name;
  const modelInvocable = !(readSkillBoolean(fields, "disable-model-invocation") ?? false);
  const userInvocable = readSkillBoolean(fields, "user-invocable") ?? true;
  const argumentHint = readSkillString(fields, "argument-hint") ?? readSkillString(fields, "dash-hint");
  const whenToUse = readSkillString(fields, "when_to_use") ?? readSkillString(fields, "when-to-use");
  const allowedTools = readSkillTools(fields);
  const canonical = fs.realpathSync.native(filePath);
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const skillId = `${source}:${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16)}:${contentHash.slice(0, 16)}`;
  return { skillId, qualifiedName: `${source}:${name}`, name, description, source, allowedTools: allowedTools?.length ? allowedTools : undefined, displayName, modelInvocable, userInvocable, argumentHint, whenToUse, root, skillPath: canonical, skillDirectory: path.dirname(canonical) };
}

/** 在一个 Skill root 内限深、限量扫描 SKILL.md。 */
function scanRoot(root: string, source: SkillSource): DiscoveredSkill[] {
  if (!fs.existsSync(root)) return [];
  const canonicalRoot = fs.realpathSync.native(root);
  const result: DiscoveredSkill[] = [];
  /** 递归访问一个目录并收集合法 Skill。 */
  function visit(folder: string, depth: number): void {
    if (depth > 5 || result.length >= MAX_SKILLS) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const item = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(item, depth + 1);
      if (entry.isFile() && entry.name === "SKILL.md") {
        try {
          const skill = parseSkill(item, source, canonicalRoot);
          const relative = skill ? path.relative(canonicalRoot, skill.skillPath) : "";
          if (skill && relative !== ".." && !relative.startsWith(`..${path.sep}`)) result.push(skill);
        } catch {
          // 无效或逃逸 Skill 只是不进入 catalog。
        }
      }
    }
  }
  visit(canonicalRoot, 0);
  return result;
}

/** 将查询拆成英文词和中文双字词，用于候选发现排序。 */
function getSearchTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase();
  const terms: string[] = [...(normalized.match(/[a-z0-9][a-z0-9-]*/g) ?? [])];
  for (const phrase of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index < phrase.length - 1; index++) terms.push(phrase.slice(index, index + 2));
  }
  return [...new Set(terms)];
}

/** 按名称和描述的词面命中对 Skill 排序。 */
function scoreSkill(skill: DiscoveredSkill, terms: string[]): number {
  const name = skill.name.toLocaleLowerCase();
  const description = skill.description.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (name.includes(term) ? 12 : description.includes(term) ? 5 : 0), 0);
}

/** 创建冻结本轮 catalog 的 Skill capability。 */
export function createSkillsCapability(workspaceRoot: string, options: NodeCapabilityLoaderOptions = {}): AgentSkillsCapability | undefined {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const roots: Array<{ root: string; source: SkillSource }> = [
    { root: path.join(workspaceRoot, ".autopilot", "skills"), source: "repo" },
    { root: path.join(homeDirectory, ".autopilot", "skills"), source: "user" },
  ];
  if (env.AGENT_SKILLS_CLAUDE_COMPAT === "true") roots.push({ root: path.join(workspaceRoot, ".claude", "skills"), source: "claude" });
  const skills = roots.flatMap(({ root, source }) => scanRoot(root, source));
  if (!skills.length) return undefined;
  const byId = new Map(skills.map((skill) => [skill.skillId, skill]));
  const byQualifiedName = new Map(skills.map((skill) => [skill.qualifiedName, skill]));
  const byName = new Map<string, DiscoveredSkill[]>();
  for (const skill of skills) byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
  const catalog = skills.map((skill) => ({ skillId: skill.skillId, qualifiedName: skill.qualifiedName, name: skill.name, description: skill.description, source: skill.source, allowedTools: skill.allowedTools, displayName: skill.displayName, modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable, argumentHint: skill.argumentHint, whenToUse: skill.whenToUse }));

  /** 返回模型可直接调用的名称；来源同名时保留限定名。 */
  function getModelSkillName(skill: DiscoveredSkill): string {
    return (byName.get(skill.name)?.length ?? 0) === 1 ? skill.name : skill.qualifiedName;
  }

  /** 以 canonical Skill 名称、qualifiedName 或 skillId 精确解析 Skill。 */
  function getSkill(skillRef: string): DiscoveredSkill {
    const exact = byQualifiedName.get(skillRef) ?? byId.get(skillRef);
    if (exact) return exact;
    const matches = byName.get(skillRef) ?? [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Skill 名称 ${skillRef} 存在多个来源，请使用 ${matches.map((skill) => skill.qualifiedName).join(" 或 ")}`);
    throw new Error("未知或未启用的 Skill");
  }

  return {
    catalog,
    async discoverSkills({ query, limit }): Promise<SkillDiscoveryCandidate[]> {
      const terms = getSearchTerms(query);
      if (!terms.length) return [];
      return skills.map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
        .slice(0, limit)
        .map(({ skill }) => ({ skill: getModelSkillName(skill), description: skill.description }));
    },
    async loadSkill({ skill: skillRef }): Promise<LoadedSkill> {
      const skill = getSkill(skillRef);
      const content = fs.readFileSync(resolveContained(skill.skillDirectory, "SKILL.md"), "utf8");
      return { skillId: skill.skillId, contentHash: crypto.createHash("sha256").update(content).digest("hex"), content, allowedTools: skill.allowedTools };
    },
    async readResource({ skill: skillRef, relativePath }): Promise<SkillResource> {
      const skill = getSkill(skillRef);
      const resource = resolveContained(skill.skillDirectory, relativePath);
      const stat = fs.statSync(resource);
      if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) throw new Error("Skill 资源不是普通文件或超过大小上限");
      return { skillId: skill.skillId, relativePath, content: fs.readFileSync(resource, "utf8") };
    },
    async prepareScript({ skill: skillRef, relativePath, args }): Promise<PreparedSkillCommand> {
      const skill = getSkill(skillRef);
      if (!relativePath.replace(/\\/g, "/").startsWith("scripts/")) throw new Error("Skill 脚本必须位于 scripts/ 目录");
      const script = resolveContained(skill.skillDirectory, relativePath);
      const extension = path.extname(script).toLowerCase();
      const program = extension === ".js" ? process.execPath : extension === ".ps1" ? "powershell.exe" : extension === ".py" ? "python" : "";
      if (!program) throw new Error("Skill 脚本类型不在宿主解释器白名单中");
      return { skillId: skill.skillId, program, args: extension === ".ps1" ? ["-File", script, ...args] : [script, ...args], cwd: skill.skillDirectory };
    },
  };
}
