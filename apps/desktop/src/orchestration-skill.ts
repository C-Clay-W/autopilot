/** 编排 Worker 的内置 Skill 正文和稳定身份，业务动作继续由 Host 授权。 */
import { createHash } from "node:crypto";
import type { AgentSkillsCapability, SkillCatalogEntry } from "@autopilot-agent/core";

const skillName = "ap-orchestration";
export const ORCHESTRATION_SKILL_ID = "builtin:ap-orchestration";
export const ORCHESTRATION_SKILL_VERSION = "2026.11.22.1";
const catalogEntry: SkillCatalogEntry = {
  skillId: ORCHESTRATION_SKILL_ID, qualifiedName: ORCHESTRATION_SKILL_ID, name: skillName,
  source: "builtin", description: "Desktop 受管编排的派工、移交、独立验证及有序收尾。",
};
export const ORCHESTRATION_DELIVERY_GUIDANCE = `普通分阶段交付完成时，在同一次 orchestration_report 中提交 local.handoff:true、空 obligations/cooperation，以及本 Turn 的新 result.id、outcome:delivered、空 unresolved、实际检查和准确产物版本。handoff 仅表示本地交接完成，步骤仍由主控验收。未完成本地工作时如实报告 partial/blocked/failed 及缺口。若在新 Turn 补交接，先实际核查原有产物和版本，再用新 resultId 同时报 local 和 result，不能只更新 local 或引用旧 Turn 报告。`;
export const ORCHESTRATION_PHASED_GUIDANCE = `普通 phased 路线：核对当前 Turn 的最新交付报告与证据，条件齐备时在同一决定中按 release → accept → dispatch 顺序推进已经规划的另一执行者。例如 actions:[{kind:'release',assignmentId:'page-maker'},{kind:'relation',action:{type:'accept',assignmentId:'page-maker',resultId:'本轮新报告ID',evidenceIds:['当前证据ID']}},{kind:'dispatch',assignmentId:'manual-writer'}]；ID 必须换成最新 query 的实际值。后续动作只会在前项成功后执行，saved 不是释放或派工成功，继续 query 核对原决定游标和回执。缺证据先实际检查；需补交接时 continue 原委派，收到新 Turn 新报告后按新 resultId 决定，不能重放已替换决定。若分次只完成释放或验收，收到 released_delivery 接续意图后，重新 query 核对原交付与仍待推进的原下游，再决定尚缺的 accept/dispatch；不要另建重复委派或向用户索取已授权派工的重复确认。已安排独立复核时保留 release → dispatch 复核分支，先拿到已释放的同版本复核证据，再 accept（带 verificationAssignmentId），不能提前验收。`;
export const ORCHESTRATION_REPORT_GUIDANCE = `本地制作完成、已经核实真实交付物、剩下仅有已安排的独立验证时，用同一次 orchestration_report 提交本地交接和可验证证据。handoff=true 表示本地交接完成，独立验收由复核者另行完成。下面是字段示例，版本、ID、相对路径和哈希都必须换成当前真实值：

{
  "expectedRevision": 42, "promptVersion": 2,
  "local": {"source":"agent","phase":"done","handoff":true,"obligations":[],"cooperation":[],"skills":[],"requiredSkills":[]},
  "result": {"id":"build-this-turn","revision":1,"summary":"本地制作完成，等待独立验证","outcome":"partial","verificationPending":true,"unresolved":[],"checks":[],"evidence":[{"id":"page","artifact":"index.html","contentVersion":"替换为实测的64位十六进制SHA-256","method":"sha256","result":"文件存在且哈希已核实","source":"agent"}]}
}

若主控已要求原委派在新 Turn 补交接，先核实原有文件相对路径和 SHA-256，保留现有产物。在新 Turn 用新 resultId（result.id）同时报告交接与当前证据，单独更新 local 无法给当前 Turn 提供交付依据。真正有本地缺口时，按实际报告局部义务、未完成项和阻塞，切勿使用 verificationPending。`;
export const ORCHESTRATION_SKILL_BODY = `# AP Desktop 编排
版本 ${ORCHESTRATION_SKILL_VERSION}

首先用 orchestration_query 确认 Host 绑定角色、当前请求、revision 和行动合同。固定主控协调同级委派，执行者只在原 Assignment 内工作。简单请求可以直接回答或用普通工具完成。审批和原生问题由人类在所属会话处理。

- handoff（移交任务）　新开受管执行者。先登记目标、背景、产物版本、未决事项和范围，再沿原批次派工。接收者实际消费完整交接后调用 orchestration_relay handoffReceived，并向原 Run 主控回报。
- phased（分阶段执行）　按依赖安排步骤、交付和验收。每个新执行者是新受管 Session；原委派的继续复用原 Session。
- parallel（并行处理）　将独立工作放入同一方案，使用 Host 已有批次确认、并发限制和 Checkout 租约。
- review（独立检查）　复用已交报告的冻结 evidence 和版本。复核实际运行检查并向原主控回报，保留失败和缺口。

${ORCHESTRATION_DELIVERY_GUIDANCE}

${ORCHESTRATION_REPORT_GUIDANCE}

${ORCHESTRATION_PHASED_GUIDANCE}

无法释放或派发时明确报告实际阻塞和原回执状态。

执行者终端收到直输，先用 inputImpact 登记影响。委派内补充自行处理并 inputResult。涉及角色、依赖、验收、共享资源或影响不明时交原主控裁决。主控可直接裁决，或先登记 clarify 再从固定主控 Turn 发 ask_user_question，收到原问题回答后把裁决仅返回该委派。

用户明确要求结束时按原输入登记收尾范围。用真实报告说明成果、检查、未覆盖项和资源状态。遇停止请求使用精确 Turn/Job 控制。保留审批、未知回执和未完成义务。已交报告、已释放和已验收是各自独立的事实。
`;
export const ORCHESTRATION_SKILL_HASH = createHash("sha256").update(ORCHESTRATION_SKILL_BODY).digest("hex");
export const orchestrationSkillRef = { skillRef: ORCHESTRATION_SKILL_ID, skillId: ORCHESTRATION_SKILL_ID, contentHash: ORCHESTRATION_SKILL_HASH, pinned: true } as const;

/** 内置限定名和内容由随包 Worker 提供，与用户同名 Skill 保持可区分。 */
export function withOrchestrationSkill(existing?: AgentSkillsCapability): AgentSkillsCapability {
  const catalog = [catalogEntry, ...(existing?.catalog.filter(function separate(entry) {
    return entry.skillId !== ORCHESTRATION_SKILL_ID && entry.qualifiedName !== ORCHESTRATION_SKILL_ID;
  }) ?? [])];
  /** 内置正文不读取工作区；其他 Skill 继续沿已受信的加载器。 */
  function isBuiltIn(ref: string) { return ref === ORCHESTRATION_SKILL_ID || ref === skillName; }
  return {
    catalog,
    async discoverSkills(request) {
      const results = await existing?.discoverSkills(request) ?? [];
      const query = request.query.toLowerCase();
      if (!/ap-orchestration|编排|派工|移交|收尾/u.test(query)) return results;
      return [{ skill: ORCHESTRATION_SKILL_ID, description: catalogEntry.description }, ...results.filter(function separate(item) { return !isBuiltIn(item.skill); })].slice(0, request.limit);
    },
    async loadSkill(request) {
      if (isBuiltIn(request.skill)) return { skillId: ORCHESTRATION_SKILL_ID, contentHash: ORCHESTRATION_SKILL_HASH, content: ORCHESTRATION_SKILL_BODY };
      if (existing) return existing.loadSkill(request);
      throw new Error("ORCHESTRATION_SKILL_MISSING");
    },
    async readResource(request) {
      if (!isBuiltIn(request.skill) && existing) return existing.readResource(request);
      throw new Error("ORCHESTRATION_SKILL_RESOURCE_MISSING");
    },
    async prepareScript(request) {
      if (!isBuiltIn(request.skill) && existing) return existing.prepareScript(request);
      throw new Error("ORCHESTRATION_SKILL_SCRIPT_MISSING");
    },
  };
}
