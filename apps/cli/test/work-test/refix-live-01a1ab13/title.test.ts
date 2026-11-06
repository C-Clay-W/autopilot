/** 自动命名只在持久身份复核通过时降级；安全/schema失败不得启动Turn。 */
import {expect,it,vi} from "vitest";
import {NodeStateError} from "@autopilot-agent/adapters";
import {createPlainRenderer} from "../../../src/renderer.js";
import {createCliController} from "../../../src/controller.js";
it.each(["storage", "schema", "identity", "missing", "busy"])("首输入命名失败 %s",async function title(kind){
  const original={id:"session",productMode:"work",projectId:"project",status:"idle",createdAt:1,updatedAt:1};
  let failed=false;
  const start=vi.fn(async function* start(){yield {type:"turn_started",turnId:"turn",stepCount:1};yield {type:"turn_completed",turnId:"turn",checkpoint:{turnId:"turn",status:"completed",stepCount:1,messages:[],completedCallIds:[]}};});
  const runtime={sessions:{get:async function get(){if(!failed)return {...original};if(kind==="missing")return null;return {...original,...(kind==="identity"?{projectId:"changed"}:{}),...(kind==="busy"?{status:"running",activeTurnId:"other"}:{})};},rename:async function rename(){failed=true;throw new NodeStateError(kind==="schema"?"STATE_SCHEMA_VERSION_UNSUPPORTED":"STATE_STORAGE_UNAVAILABLE");}},turns:{start}} as any;
  const controller=createCliController({sessionId:"session",runtime,renderer:createPlainRenderer("text")});
  if(kind==="storage"){const result=await controller.dispatch({type:"submit_prompt",content:"首任务"});expect(start).toHaveBeenCalledTimes(1);expect(result.lines.join(" ")).toContain("自动标题未保存");}
  else {await expect(controller.dispatch({type:"submit_prompt",content:"首任务"})).rejects.toBeInstanceOf(NodeStateError);expect(start).not.toHaveBeenCalled();}
});
