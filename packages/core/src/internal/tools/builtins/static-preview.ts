/** 既有open_preview的单文件静态准备：固定Node服务、系统分配端口和既有Job生命周期。 */
import { createServer } from "node:net";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { JobService } from "../../../runtime/application/job-service";
import type { ToolExecutionContext } from "../types";
import { createToolError } from "../tool-error";
import { resolveFileTarget } from "../permissions/path-access-policy";

/** 服务只公开批准的HTML单文件，拒绝其他方法/路径；不公开目录、资源或工作区。 */
export const STATIC_PREVIEW_SCRIPT = `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const file=process.argv[1],port=Number(process.argv[2]);const route='/'+encodeURIComponent(path.basename(file));const server=http.createServer(function serve(req,res){if(!['GET','HEAD'].includes(req.method)||req.url!==route){res.writeHead(404);return res.end();}fs.realpath(file,function resolved(err,actual){if(err||actual!==file){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(file);stream.on('error',function failed(){res.destroy();});stream.pipe(res);});});server.listen(port,'127.0.0.1');`;

/** 审批前验证规范相对HTML路径及canonical边界；不启动进程，不猜测端口。 */
export async function resolveStaticPreviewFile(workspaceRoot: string | undefined, staticPath: string): Promise<string> {
  if (!workspaceRoot || !/\.html?$/iu.test(staticPath) || staticPath.includes("\\") || staticPath.includes(":" ) || staticPath.startsWith("/") || staticPath.split("/").some(function invalid(part) { return !part || part === "." || part === ".." || part.startsWith("."); })) throw createToolError("PREVIEW_INVALID_TARGET", "静态预览仅支持工作区内规范相对HTML文件");
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
