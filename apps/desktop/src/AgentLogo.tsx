// 本地产品 Logo 仅作工具识别，来源和许可证随资源保留。
import type { AgentType } from "./workspace";

const autopilotLogo: string = require("./assets/agent-light.svg");
const logos: Record<Exclude<AgentType, "ap">, string> = { claude: require("./assets/claude.svg"), codex: require("./assets/codex.svg"), opencode: require("./assets/opencode.svg"), codebuddy: require("./assets/codebuddy.svg") };
/** 名称由相邻文字或父控件提供，避免读屏重复朗读。 */
export function AgentLogo({ agent }: { agent: AgentType }) {
  return <img src={agent === "ap" ? autopilotLogo : logos[agent]} alt="" aria-hidden="true" className={`desktop-agent-logo size-4 shrink-0${agent === "ap" ? "" : " brightness-0 invert"}`} />;
}
