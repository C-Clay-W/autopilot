// 技能安装只在隔离home验证，覆盖目录发现、重复安装与用户自定义保护。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserSkillStatus, installBrowserSkill } from "../src/browser-skills";
import { browserScreenshot } from "../src/browser-driver";

test("managed skills preserve custom content and screenshots do not leak paths", async function distribution() {
  const home = await mkdtemp(join(tmpdir(), "browser-distribution-"));
  const config = join(home, "custom-claude");
  const before = await browserSkillStatus(home, config);
  assert.equal(before.length, 3); assert.ok(before.every(function missing(item) { return item.state === "missing"; }));
  for (const item of before) { await installBrowserSkill(item.id, home, config); await installBrowserSkill(item.id, home, config); }
  const after = await browserSkillStatus(home, config);
  assert.ok(after.every(function current(item) { return item.state === "current"; }));
  assert.equal(after[0].path, join(home, ".agents", "skills", "ap-browser"));
  assert.equal(after[1].path, join(config, "skills", "ap-browser"));
  const file = join(after[0].path, "SKILL.md");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace(/managed \d+/, "managed 0"));
  assert.equal((await browserSkillStatus(home, config))[0].state, "update");
  await installBrowserSkill("agents", home, config); assert.equal(await readFile(file, "utf8"), original);
  await writeFile(file, original + "\nuser edit");
  await assert.rejects(installBrowserSkill("agents", home, config), /CUSTOM/);
  assert.equal(await readFile(file, "utf8"), original + "\nuser edit");
  const png = join(home, "image.png");
  await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const result = await browserScreenshot(png) as { content: { type: string; data: string }[] };
  assert.equal(result.content[0].type, "image"); assert.ok(!JSON.stringify(result).includes(home));
  await writeFile(png, "not a PNG"); await assert.rejects(browserScreenshot(png), /SCREENSHOT_INVALID/);
});
