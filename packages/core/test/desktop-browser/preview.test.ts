/** Markdown单文件服务及实际Desktop browser入口的离线定向回归。 */
import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createBrowserTool } from "../../src/internal/tools/builtins/browser-tool";
import { STATIC_PREVIEW_SCRIPT, resolveStaticPreviewFile } from "../../src/internal/tools/builtins/static-preview";
import { createAgentRuntime } from "../../src/internal/agent-runtime";
import type { JobService } from "../../src/runtime/application/job-service";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";

it("Desktop browser previews selected Markdown through existing managed Job and preserves HTML", async function preview() {
  const root = await mkdtemp(path.join(tmpdir(), "ap-preview-quality-"));
  await writeFile(path.join(root, "报告.md"), '# 文档\n\n**正文**\n- 项目\n```js\n<script>secret()</script>\n```\n<img src="https://remote.invalid/x">');
  await writeFile(path.join(root, "page.html"), '<!doctype html><title>HTML unchanged</title>');
  const children: ChildProcess[] = [];
  let job: any;
  const start = vi.fn(async function start(input) {
    const child = spawn(input.program, input.args, { windowsHide: true, stdio: "ignore" }); children.push(child);
    job = { ...input, id: 'job', status: 'running' }; return job;
  });
  const jobs = { start, get: async function get() { return job; }, forSession: function session() { return { list: async function list() { return { jobs: job ? [{ jobId: 'job', status: 'running', controlState: 'owned' }] : [] }; }, verifyServiceOwnership: async function ownership() { return 'owned'; } }; } } as unknown as JobService;
  const calls: any[] = [];
  const browser = { request: async function request(binding, callId, operation) { calls.push({ binding, callId, operation }); return operation; }, endTurn: async function end() {} };
  const binding = { sessionId: 'session', turnId: 'turn' };
  const tool = createBrowserTool(browser, binding, undefined, { jobs, workspaceId: root, workspaceRoot: root });
  // 真实Desktop使用browserEnabled而不注册open_preview，tool目录仍可发现staticPath。
  const definitions = createAgentRuntime({ browser, browserBinding: binding, jobs, jobBinding: { ...binding, workspaceId: root }, workspaceRoot: root, capabilityCeiling: { productMode: 'work' } }).getToolDefinitions();
  expect(definitions.find(function browser(definition) { return definition.name === 'browser'; })?.description).toContain('staticPath');
  expect(definitions.some(function preview(definition) { return definition.name === 'open_preview'; })).toBe(false);
  const input = tool.inputSchema.parse({ type: 'open', staticPath: '报告.md' });
  await tool.validateInput?.(input, { permissionMode: 'ask' });
  expect(await tool.createActionFacts?.(input, { permissionMode: 'ask' })).toMatchObject({ requiresApproval: true, operation: 'prepare_static_preview' });
  const registry = new ToolRegistry({ productMode: 'work' }); registry.register(tool);
  const executor = new ToolExecutor(registry, { capabilityCeiling: { productMode: 'work' }, permissionMode: 'ask', workspaceTrusted: true });
  expect((await executor.execute({ toolName: 'browser', callId: 'blocked', input })).status).not.toBe('success');
  expect(start).not.toHaveBeenCalled();
  const context = { toolCallId: 'call', permissionMode: 'ask' as const, sandboxPolicy: { execution: 'host' as const, policy: { mode: 'workspace-write' } as never } };
  try {
    const result = await tool.execute(input, context) as any;
    expect(calls[0].binding).toEqual(binding); expect(calls[0].callId).toBe('call');
    let response: Response | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { response = await fetch(result.url); break; } catch { await new Promise(function wait(resolve) { setTimeout(resolve, 25); }); }
    }
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('text/html');
    expect(response?.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response!.text();
    expect(html).toContain('<h1>文档</h1>'); expect(html).toContain('<strong>正文</strong>'); expect(html).toContain('<li>项目</li>');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
    expect((await fetch(new URL('/page.html', result.url))).status).toBe(404);
    expect((await fetch(result.url, { method: 'POST' })).status).toBe(404);
    await tool.execute(input, context); expect(start).toHaveBeenCalledTimes(1);
    expect(job.args[1]).toBe(STATIC_PREVIEW_SCRIPT);
    // 同一服务仅提供选中文档；HTML入口继续逐字返回，保持已有执行契约。
    job = undefined;
    const htmlResult = await tool.execute(tool.inputSchema.parse({ type: 'open', staticPath: 'page.html' }), context) as any;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { response = await fetch(htmlResult.url); break; } catch { await new Promise(function wait(resolve) { setTimeout(resolve, 25); }); }
    }
    expect(await response!.text()).toBe('<!doctype html><title>HTML unchanged</title>');
  } finally {
    await Promise.all(children.map(function stop(child) { return new Promise<void>(function closed(resolve) { child.once('close', function done() { resolve(); }); child.kill(); }); }));
  }
  for (const invalid of ['../报告.md', '/private/doc.md', 'C:\\private\\doc.md', 'sub\\doc.md', '.secret.md']) await expect(resolveStaticPreviewFile(root, invalid)).rejects.toBeDefined();
  expect(tool.inputSchema.safeParse({ type: 'open', staticPath: '报告.md', url: 'https://example.test' }).success).toBe(false);
  await expect(createBrowserTool(browser, binding).validateInput?.(input, { permissionMode: 'ask' })).rejects.toBeDefined();
});
