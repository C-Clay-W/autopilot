/** Stage5 通过生产 Adapter 包入口验证 Web 保存与 CLI 共用读取。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createNodeSettingsLoader } from "@autopilot-agent/adapters";
import { createCredentialSettingsService } from "../../lib/settings/credential-settings";
it("Web 分类保存、CLI 读取、手写回显、修订冲突和秘密不回显", async function productionEntryInterop() {
 const homeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),"cr-web-stage5-"));
 try {
  const service=createCredentialSettingsService({homeDirectory});const initial=service.getStatus();
  const status=await service.save({category:"main",revision:initial.revision,main:{provider:"custom",baseUrl:"https://main.invalid/anthropic",model:"model-a",apiKey:"private-main"},search:{enabled:true,useMainKey:false,provider:"openai-compatible",baseUrl:"https://search.invalid/v1",model:"search-a",apiKey:"private-search"}});
  expect(JSON.stringify(status)).not.toContain("private-");
  const loader=createNodeSettingsLoader({homeDirectory});expect(loader.loadUser().settings.modelRef?.modelId).toBe("model-a");
  const rag=await service.save({category:"rag",revision:status.revision,rag:{textEmbedding:{provider:"openai-compatible",baseUrl:"https://embedding.invalid/v1",model:"embed",dimension:2,apiKey:"private-embed"}}});
  expect(rag.main.model).toBe("model-a");expect(JSON.stringify(rag)).not.toMatch(/private-|credentialRef/);
  await expect(service.save({category:"rag",revision:status.revision,rag:{}})).rejects.toMatchObject({code:"SETTINGS_CHANGED"});
  const file=path.join(homeDirectory,".autopilot","settings.json"),raw=JSON.parse(fs.readFileSync(file,"utf8"));raw.env.ANTHROPIC_MODEL="model-b";raw.availableModels=["model-b"];fs.writeFileSync(file,JSON.stringify(raw));
  expect(service.getStatus().main.model).toBe("model-b");expect(loader.loadUser().settings.modelRef?.modelId).toBe("model-b");
 } finally { if(path.dirname(homeDirectory)!==os.tmpdir()||!path.basename(homeDirectory).startsWith("cr-web-stage5-"))throw new Error("invalid cleanup");fs.rmSync(homeDirectory,{recursive:true,force:true}); }
});
