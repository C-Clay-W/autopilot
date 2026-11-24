/** 编排主控投递保留用户原文，按 Worker 请求预算装入已核验的文件摘录。 */
import { fitFileMentionContext, fitFileMentionReferences, type FileMentionReference } from "@autopilot-agent/cli/dist/file-mention-budget.js";
import { fitsManagedCommandPayload, type ManagedRuntimeCommand, type ManagedRuntimeIdentity } from "./managed-runtime-service";
import type { OrchestrationRun } from "./orchestration-store";
import { ORCHESTRATION_SKILL_BODY } from "./orchestration-skill";

type WakeCommand = Pick<ManagedRuntimeCommand, "requestId" | "sessionId" | "turnId" | "previousTurnId" | "queued"> & { operation: "start" | "steer" };

const instruction = "你是本 Run 固定 AP 主控。用户明确停止整次编排时，query 后以唯一 stopRun 动作办理；按实际回执反馈，不能仅口头答应。userInputs 按时间顺序排列；若本批包含 correction 的旧结构错误意图，先查询最新合同，只纠正仍符合当前目标的原决定；允许用空 actions 放弃已被最新输入替代的旧计划，不重复执行旧输入。先结合最新原文理解补充、替代或取消意图，再决定本次目标，不得先执行已被用户改写的旧要求。你具备普通 AP CLI/Runtime 的工具与技能能力，并额外承担编排职责；按用户目标自主判断直接回答、使用正常工具完成简单只读/简单操作，或将复杂任务委派。简单请求无需 orchestration_query/decide、step、assign、seal 或 accept，宿主依据精确输入消费和 Turn 完成事实记账；查询编排状态也不强制建立计划。复杂委派才先 orchestration_query 读取合同，再用 step/assign/seal/dispatch；遵守正常权限与工具审批，不要求用户重复授权。受管 Session 禁用原生 Thread/子代理，必要协作必须走平级 Assignment；不得静默跳过 Skill 要求的独立验证。已有执行者持有目录时不得自行并发写入，先核查真实状态并沿编排资源准入协调。仅处理 intentIds 指定的新事项，query 中其他 prompts 是历史上下文，不得再次回答；错误状态仅核查阻塞，不重答历史问题。真正工具审批由人类处理；遇到阻塞先查询真实状态，不把普通用户输入当审批决定。";

/** 优先装入原文和路径，再用完整请求校验为摘录分配剩余空间。 */
export function buildOrchestrationWakeCommand(identity: ManagedRuntimeIdentity, wake: WakeCommand, intentIds: string[], prompts: OrchestrationRun["prompts"]): Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity> | undefined {
  const command = {
    ...wake,
    attachments: prompts.flatMap(function images(prompt) { return prompt.attachments ?? []; }),
    selectedSkills: prompts.flatMap(function skills(prompt) { return prompt.selectedSkills ?? []; }),
    activeSkills: prompts.flatMap(function skills(prompt) { return prompt.activeSkills ?? []; }),
  };
  const originals = prompts.map(function original({ version, text, scope, targetId, executorSource, flow }) { return { version, text, scope, targetId, executorSource, flow }; });
  const guidance = [
    instruction,
    prompts.some(function direct(p) { return !!p.executorSource; }) ? "executorSource 标识执行者收到的独立人类输入。它已定向交给原执行者判断；先查询处理状态。局部请求只观察，跨范围请求用 orchestration_relay 直接裁决或从当前主控发起澄清。" : "",
    prompts.some(function flow(p) { return !!p.flow; }) ? "本次用户选择了 userInputs.flow。按内置 Skill 和首行之后的用户原文工作。空正文仅续接现有任务。\n" + ORCHESTRATION_SKILL_BODY : "",
  ].filter(Boolean).join(" ");
  // 先按共同预算处理旧队列保存的摘录，再检查整批 IPC 大小。
  const groups = prompts.map(function mentions(prompt) { return fitFileMentionContext(prompt.text, prompt.fileMentions); });
  const hasMentions = groups.some(function hasReferences(group) { return !!group?.length; });
  const plain = { ...command, content: JSON.stringify({ instruction: guidance, intentIds, userInputs: originals }) };
  if (!fitsManagedCommandPayload({ ...plain, ...identity })) return undefined;
  if (!hasMentions) return plain;

  /** 计入嵌套 JSON 转义和 IPC 身份字段，预留工作区引用说明。 */
  function serialize(groups: readonly (readonly FileMentionReference[] | undefined)[]) {
    const userInputs = originals.map(function withReferences(input, index) { return { ...input, fileMentions: groups[index] }; });
    return JSON.stringify({ instruction: `${guidance} fileMentions 是工作区参考资料。缺少正文或标记截断时可按 path 按需读取；预览文件可直接使用路径。`, intentIds, userInputs });
  }
  if (!fitsManagedCommandPayload({ ...command, ...identity, content: serialize([]) })) return plain;
  const references = fitFileMentionReferences(groups, function fits(candidate) {
    return fitsManagedCommandPayload({ ...command, ...identity, content: serialize(candidate) });
  });
  return { ...command, content: serialize(references) };
}
