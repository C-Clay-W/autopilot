/** 既有open_preview的单文件静态准备：固定Node服务、系统分配端口和既有Job生命周期。 */
import { createServer } from "node:net";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { JobService } from "../../../runtime/application/job-service";
import type { ToolExecutionContext } from "../types";
import { createToolError } from "../tool-error";
import { resolveFileTarget } from "../permissions/path-access-policy";

/** 服务只公开批准的HTML单文件，拒绝其他方法/路径；不公开目录、资源或工作区。 */
export const STATIC_PREVIEW_SCRIPT = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[1];
const port = Number(process.argv[2]);
const markdown = /\.(md|markdown)$/i.test(file);
const route = '/' + encodeURIComponent(process.argv[3] || path.basename(file));
const backtick = String.fromCharCode(96);
const inlineCode = new RegExp(backtick + '([^' + backtick + ']+)' + backtick, 'g');

// 原始HTML全部转义；文档不加载链接、图片、脚本或远程依赖。
function escapeHtml(character) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
}

// 基础块级排版保持单文件预览范围，代码块只输出已转义正文。
function render(source) {
  let code = false;
  const parts = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trimStart().startsWith(backtick.repeat(3))) {
      parts.push(code ? '</code></pre>' : '<pre><code>');
      code = !code;
      continue;
    }
    const safe = line.replace(/[&<>"']/g, escapeHtml);
    if (code) {
      parts.push(safe + '\n');
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(safe);
    const list = /^\s*(?:[-*+] |\d+\. )(.+)$/.exec(safe);
    const body = (heading ? heading[2] : list ? list[1] : safe)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(inlineCode, '<code>$1</code>');
    if (heading) parts.push('<h' + heading[1].length + '>' + body + '</h' + heading[1].length + '>');
    else if (list) parts.push('<ul><li>' + body + '</li></ul>');
    else parts.push(body ? '<p>' + body + '</p>' : '');
  }
  if (code) parts.push('</code></pre>');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + '<title>Markdown preview</title><style>'
    + 'body{max-width:960px;margin:40px auto;padding:0 24px;font:17px/1.65 system-ui;color:#222;background:#fff;overflow-wrap:anywhere}'
    + 'pre{overflow:auto;padding:16px;background:#f3f3f3}code{font-family:monospace}h1,h2,h3{line-height:1.25}ul{margin:0}'
    + '</style><main>' + parts.join('\n') + '</main>';
}

// 只允许所选文档的GET/HEAD；重新核对真实路径，不公开目录或其他资源。
const server = http.createServer(function serve(req, res) {
  if (!['GET', 'HEAD'].includes(req.method) || req.url !== route) {
    res.writeHead(404);
    return res.end();
  }
  fs.realpath(file, function resolved(error, actual) {
    if (error || actual !== file) {
      res.writeHead(404);
      return res.end();
    }
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (markdown) {
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      fs.stat(file, function info(error, stat) {
        if (error || !stat.isFile() || stat.size > 2 * 1024 * 1024) {
          res.writeHead(413);
          return res.end();
        }
        fs.readFile(file, 'utf8', function read(error, source) {
          if (error) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, headers);
          res.end(req.method === 'HEAD' ? undefined : render(source));
        });
      });
      return;
    }
    // HTML沿用原始字节流与既有资源契约。
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', function failed() { res.destroy(); });
    stream.pipe(res);
  });
});
// 只有Desktop申请随机端口时向所属Worker返回就绪端口，既有Job不产生额外输出。
server.listen(port, '127.0.0.1', function ready() {
  if (port === 0) process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
`;

/** 审批前验证规范相对HTML路径及canonical边界；不启动进程，不猜测端口。 */
export async function resolveStaticPreviewFile(workspaceRoot: string | undefined, staticPath: string): Promise<string> {
  if (!workspaceRoot || !/\.(?:html?|md|markdown)$/iu.test(staticPath) || staticPath.includes("\\") || staticPath.includes(":" ) || staticPath.startsWith("/") || staticPath.split("/").some(function invalid(part) { return !part || part === "." || part === ".." || part.startsWith("."); })) throw createToolError("PREVIEW_INVALID_TARGET", "静态预览仅支持工作区内规范相对HTML或Markdown文件");
  const target = await resolveFileTarget(workspaceRoot, staticPath);
  if (target.isExternal || !(await stat(target.canonicalTarget)).isFile()) throw createToolError("PREVIEW_INVALID_TARGET", "静态预览文件不存在或不在工作区内");
  return await realpath(target.canonicalTarget);
}

/** 向操作系统申请空闲loopback端口；启动竞争只报告失败，不盲目重复启动。 */
async function allocatePort(): Promise<number> {
  return await new Promise<number>(function allocate(resolve, reject) {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", function listening() {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(createToolError("PREVIEW_UNAVAILABLE", "无法准备静态预览服务")); return; }
      server.close(function closed(error) { if (error) reject(error); else resolve(address.port); });
    });
  });
}

/** 已通过ToolExecutor进程审批后复用同会话固定服务，或只启动一个受管Job。 */
export async function prepareStaticPreview(input: { jobs: JobService; workspaceId: string; workspaceRoot: string; sessionId: string; turnId: string; staticPath: string }, context: ToolExecutionContext): Promise<{ url: string; jobId: string }> {
  const file = await resolveStaticPreviewFile(input.workspaceRoot, input.staticPath);
  const scoped = input.jobs.forSession(input);
  const page = await scoped.list({ limit: 100 });
  const jobs = page.jobs;
  for (const item of jobs) {
    if (!["starting", "running"].includes(item.status)) continue;
    const job = await input.jobs.get(item.jobId);
    if (job?.sessionId !== input.sessionId || job.workspaceId !== input.workspaceId || job.program !== process.execPath || job.args[1] !== STATIC_PREVIEW_SCRIPT || job.args[2] !== file || !job.serviceUrl) continue;
    if (item.controlState !== "owned") throw createToolError("PREVIEW_JOB_UNAVAILABLE", "已有静态服务的控制归属无法确认，请先处理原Job");
    const ownership = await scoped.verifyServiceOwnership({ jobId: job.id, serviceUrl: job.serviceUrl });
    if (ownership === "unowned") throw createToolError("PREVIEW_JOB_UNAVAILABLE", "现有静态服务归属已失效，请先处理原Job");
    return { jobId: job.id, url: new URL(encodeURIComponent(path.basename(file)), job.serviceUrl + "/").href };
  }
  if (page.nextPageCursor) throw createToolError("PREVIEW_CAPACITY_REACHED", "后台任务过多，无法确认是否已有静态服务，请先处理已有Job");
  if (!context.sandboxPolicy) throw createToolError("SANDBOX_UNAVAILABLE", "静态服务未获受控进程执行授权");
  const port = await allocatePort();
  const serviceUrl = `http://127.0.0.1:${port}`;
  const job = await input.jobs.start({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, sessionId: input.sessionId, turnId: input.turnId, program: process.execPath, args: ["-e", STATIC_PREVIEW_SCRIPT, file, String(port)], cwd: ".", serviceUrl, sandbox: context.sandboxPolicy, toolCallId: context.toolCallId, signal: context.signal });
  if (!["running", "starting"].includes(job.status)) throw createToolError("PREVIEW_JOB_UNAVAILABLE", "静态服务启动失败，请检查原Job");
  return { jobId: job.id, url: new URL(encodeURIComponent(path.basename(file)), serviceUrl + "/").href };
}
