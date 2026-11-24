// 浏览器技能只写固定发现目录；内容校验保护用户修改，不操作全局CLI安装。
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { BrowserSkillStatus } from "./browser-contract";

const version = "3";
export const browserSkillBody = `---
name: ap-browser
description: Autopilot Desktop 内置浏览器必须使用 ap browser；不要误选 Codex IAB / Computer Use。Use the Desktop-managed browser through one approved native shell action.
---

# Autopilot Desktop browser

Use only in a Desktop-managed terminal with its native browser integration enabled.
For Autopilot Desktop 内置浏览器 use ap browser, never Codex IAB / Computer Use.
Ordinary shell commands and an explicitly requested external browser remain native CLI behavior; this contract does not globally disable them.
Use the foreground shell tool with exactly one command: ap browser ACTION 'JSON'.
Do not combine commands, redirect, background, specify a permit, or call agent-browser/CDP directly.
Native integration supplies identity, current user turn and a single-use permit. If unavailable, stop and report the error; never bypass it.

Examples:

    ap browser open '{"url":"https://example.com"}'
    ap browser document '{"path":"C:/Users/Example/中文 Vault/plan.md"}'
    ap browser document '{"path":"/Users/example/中文 Vault/plan.md"}'
    ap browser document '{"path":"docs/plan.md"}'
    ap browser list '{}'
    ap browser snapshot '{"pageId":"PAGE_UUID","revision":0}'
    ap browser click '{"pageId":"PAGE_UUID","revision":0,"ref":"@e1"}'
    ap browser fill '{"pageId":"PAGE_UUID","revision":0,"ref":"@e1","value":"hello"}'
    ap browser screenshot '{"pageId":"PAGE_UUID","revision":0}'

For a user-selected local Markdown/HTML file, use document(path), including explicit absolute paths outside the Desktop workspace. Relative paths resolve against the Desktop pane workspace. The Desktop asks for the exact canonical file; current-turn approval can reuse that file, not arbitrary other files. Never pass file URLs to open, navigate or screenshot: BROWSER_FILE_URL_USE_DOCUMENT means call document first, then screenshot(pageId,revision).

Use returned pageId/revision and fresh snapshot refs. Never infer refs or reuse them after navigation.
Allowed actions: list, document(path), open(url), navigate(pageId,revision,url), select/close/release/back/forward/reload/snapshot/screenshot(pageId,revision), click(ref), fill(ref,value), press(key), scroll(direction,amount), select-option(ref,value), check(ref,checked), dialog(accept,text), wait(condition="load",timeout=1..30000ms), downloads, cancel-download(id).
All element/key/scroll/dialog actions also require pageId and revision. JSON must not include type. Encode apostrophes inside JSON using the JSON Unicode escape for U+0027 to preserve the outer single quotes.
An approval grants exactly one action or this agent's current user turn. A new user turn needs new authorization. Do not try to supply caller or turn identifiers.
Wait for the original shell execution to finish (including a yielded Codex execution); do not resubmit after timeout or disconnection because the action may already have occurred.
On busy, paused, stale target or denial, report it and wait for the user. Do not take over another agent's page or retry a mutating action automatically.
Screenshots return PNG image content. Do not print image base64 in prose.
`;

/** 单文件管理标记记录正文摘要，编辑过的技能一律视为自定义。 */
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
const content = `${browserSkillBody}\n<!-- autopilot-browser-managed ${version} sha256:${digest(browserSkillBody)} -->\n`;

/** 按已确认的发现规则选目录，Codex与OpenCode共享agents目录。 */
function directory(id: BrowserSkillStatus["id"], home: string, claudeConfig?: string): string {
  if (id === "claude") return join(claudeConfig && isAbsolute(claudeConfig) ? claudeConfig : join(home, ".claude"), "skills", "ap-browser");
  return join(home, id === "codebuddy" ? ".codebuddy" : ".agents", "skills", "ap-browser");
}

/** 不跟随技能目录或文件符号链接，不覆盖附带用户文件的目录。 */
async function inspect(root: string, legacyLocal = false): Promise<BrowserSkillStatus["state"]> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "custom";
    const entries = await readdir(root);
    if (entries.length !== 1 || entries[0] !== "SKILL.md") return "custom";
    const file = join(root, "SKILL.md");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return "custom";
    const text = await readFile(file, "utf8");
    if (text === content) return "current";
    // 旧Desktop局部生成文件无标记，只迁移精确已知正文；全局安装不采用此路径。
    if (legacyLocal && digest(text) === "de2dd5c4749b08a595c0f11161c17080dacd4ef6c85d177873f0c9c8688f1d87") return "update";
    const match = /^([\s\S]*)\n<!-- autopilot-browser-managed (\S+) sha256:([a-f0-9]{64}) -->\n$/.exec(text);
    return match && digest(match[1]) === match[3] ? "update" : "custom";
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; return "unavailable"; }
}

/** 检测只读取技能文件，不启动任何第三方CLI或修改用户目录。 */
export async function browserSkillStatus(home = homedir(), claudeConfig = process.env.CLAUDE_CONFIG_DIR): Promise<BrowserSkillStatus[]> {
  return Promise.all((["agents", "claude", "codebuddy"] as const).map(async function status(id) {
    const path = directory(id, home, claudeConfig);
    return { id, label: id === "agents" ? "Codex / OpenCode" : id === "claude" ? "Claude" : "CodeBuddy", path, state: await inspect(path) };
  }));
}

/** 原子更新已标记技能；只在Desktop自有目录接受精确旧版正文，自定义文件拒绝覆盖。 */
async function updateBrowserSkill(root: string, legacyLocal: boolean): Promise<void> {
  const state = await inspect(root, legacyLocal);
  if (state === "current") return;
  if (state !== "missing" && state !== "update") throw new Error("BROWSER_SKILL_CUSTOM_OR_UNAVAILABLE");
  const file = join(root, "SKILL.md");
  if (state === "missing") {
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink() || (await readdir(root)).length) throw new Error("BROWSER_SKILL_CHANGED");
    await writeFile(file, content, { flag: "wx" }); return;
  }
  const original = await readFile(file, "utf8");
  const temporary = join(root, `.SKILL-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: "wx" });
  try {
    if (await readFile(file, "utf8") !== original) throw new Error("BROWSER_SKILL_CHANGED");
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(function absent(error: NodeJS.ErrnoException) { if (error.code !== "ENOENT") throw error; }); }
}

/** 受管启动仅传入Desktop自有目录，兼容旧版精确生成内容。 */
export async function prepareManagedBrowserSkill(root: string): Promise<void> {
  await updateBrowserSkill(root, true);
}

/** 设置页显式安装沿用原用户目录，不自动接管无标记用户文件。 */
export async function installBrowserSkill(id: BrowserSkillStatus["id"], home = homedir(), claudeConfig = process.env.CLAUDE_CONFIG_DIR): Promise<void> {
  await updateBrowserSkill(directory(id, home, claudeConfig), false);
}
