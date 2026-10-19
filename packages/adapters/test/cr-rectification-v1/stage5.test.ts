/** Stage5 回归：真实包解析、凭据冻结、迁移闭合和 Search 禁用。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNodeUserSettingsService, createNodeSettingsLoader, createNodeCapabilityLoader, createNodeRagRuntime } from "../../src";
const roots: string[] = [];
/** 生成仅包含合成凭据的隔离配置。 */
function fixture() {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cr-stage5-")); roots.push(homeDirectory);
  const service = createNodeUserSettingsService({ homeDirectory });
  const loader = createNodeSettingsLoader({ homeDirectory });
  const file = path.join(homeDirectory, ".autopilot", "settings.json");
  return { homeDirectory, service, loader, file };
}
/** 仅清理本文件创建且位于临时根内的目录。 */
afterEach(function cleanup() { for (const root of roots.splice(0)) { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("cr-stage5-")) throw new Error("invalid cleanup"); fs.rmSync(root, { recursive: true, force: true }); } });
it("更换主地址必须提交 Key，同地址更换模型保留 Key", async function mainKeyBoundary() {
 const { service, file } = fixture();
 await service.saveMain({ baseUrl:"https://a.invalid/anthropic", model:"a", apiKey:"key-a" });
 const before=fs.readFileSync(file,"utf8");
 await expect(service.saveMain({baseUrl:"https://b.invalid/anthropic",model:"b"})).rejects.toMatchObject({code:"SETTINGS_KEY_REQUIRED"});
 expect(fs.readFileSync(file,"utf8")).toBe(before);
 await service.saveMain({baseUrl:"https://a.invalid/anthropic",model:"b"});
 expect(JSON.parse(fs.readFileSync(file,"utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe("key-a");
});
it("显式禁用 Search 阻止官方主连接和残留搜索 Key 自动继承", async function disabledSearch() {
 const {service,loader,file}=fixture();
 await service.saveMainCategory({main:{baseUrl:"https://api.deepseek.com/anthropic",model:"deepseek-v4-flash",apiKey:"key-a"},search:{enabled:false,useMainKey:false,provider:"deepseek",baseUrl:"https://api.deepseek.com",model:"deepseek-v4-flash"}});
 const raw=JSON.parse(fs.readFileSync(file,"utf8"));raw.env.USER_SETTINGS_WEB_SEARCH_DEEPSEEK="old-key";fs.writeFileSync(file,JSON.stringify(raw));
 expect(loader.loadUser().settings.diagnostics).toEqual([]);
 expect(service.getStatus().search.enabled).toBe(false);
 expect((await createNodeCapabilityLoader({settingsLoader:loader}).loadChatWeb({retrievalMode:"web"}))?.search).toBeUndefined();
});
it("旧 Search 与 RAG 实例冻结 A 凭据，新实例读取 B", async function frozenCredentials() {
 const {service,loader,file}=fixture();
 const main={baseUrl:"https://a.invalid/anthropic",model:"a",apiKey:"main-key"};
 await service.saveMainCategory({main,search:{enabled:true,useMainKey:false,provider:"openai-compatible",baseUrl:"https://search-a.invalid/v1",model:"a",apiKey:"search-a"}});
 await service.saveRag({textEmbedding:{provider:"openai-compatible",baseUrl:"https://embed-a.invalid/v1",model:"a",dimension:2,apiKey:"embed-a"}});
 const seen: Array<{url:string;authorization:string}> = [];
 const runtime=createNodeCapabilityLoader({settingsLoader:loader,webSearchFetch:async function respond(url,init){seen.push({url:String(url),authorization:new Headers(init?.headers).get("authorization")??""});return Response.json({object:"response",status:"completed",output:[{type:"web_search_call",status:"completed"},{type:"message",status:"completed",content:[{type:"output_text",text:"answer",annotations:[]}]}]});}});
 const oldSearch=await runtime.loadChatWeb({retrievalMode:"web"});
 const oldRag=createNodeRagRuntime({settings:loader.loadUser().settings,userSettingsPath:file});
 await service.saveMainCategory({main,search:{enabled:true,useMainKey:false,provider:"openai-compatible",baseUrl:"https://search-b.invalid/v1",model:"b",apiKey:"search-b"}});
 await service.saveRag({textEmbedding:{provider:"openai-compatible",baseUrl:"https://embed-b.invalid/v1",model:"b",dimension:2,apiKey:"embed-b"}});
 await oldSearch?.search?.search({query:"test"});
 await (await runtime.loadChatWeb({retrievalMode:"web"}))?.search?.search({query:"test"});
 expect(seen).toEqual([{url:"https://search-a.invalid/v1/responses",authorization:"Bearer search-a"},{url:"https://search-b.invalid/v1/responses",authorization:"Bearer search-b"}]);
 await expect(oldRag.embedding.text?.resolveApiKey()).resolves.toBe("embed-a");
 await expect(createNodeRagRuntime({settings:loader.loadUser().settings,userSettingsPath:file}).embedding.text?.resolveApiKey()).resolves.toBe("embed-b");
});
it("迁移保留其他 route 共用的旧 Key", async function retainsSharedKey() {
 const {service,file}=fixture();fs.mkdirSync(path.dirname(file),{recursive:true});
 const route={apiProtocol:"openai-chat-completions",baseUrl:"https://a.invalid",credentialRef:{provider:"legacy",key:"SHARED_KEY"},models:[{id:"model"}]};
 fs.writeFileSync(file,JSON.stringify({model:"legacy/model",env:{SHARED_KEY:"shared"},providerRoutes:{legacy:{...route,id:"legacy"},retained:{...route,id:"retained",credentialRef:{provider:"retained",key:"SHARED_KEY"}}}}));
 await service.saveMain({baseUrl:"https://b.invalid/anthropic",model:"b",apiKey:"new"});
 const raw=JSON.parse(fs.readFileSync(file,"utf8"));expect(raw.env.SHARED_KEY).toBe("shared");expect(raw.providerRoutes.retained).toBeDefined();
});
it("无效显式 Search 不被诊断过滤或默认继承掩盖", async function invalidSearch() {
 const {service,file,loader}=fixture();fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:"key",ANTHROPIC_BASE_URL:"https://api.deepseek.com/anthropic",ANTHROPIC_MODEL:"deepseek-v4-flash"},webSearch:{provider:"invalid"}}));
 expect(()=>service.getStatus()).toThrow("SETTINGS_INVALID");
 expect((await createNodeCapabilityLoader({settingsLoader:loader}).loadChatWeb({retrievalMode:"web"}))?.search).toBeUndefined();
});
