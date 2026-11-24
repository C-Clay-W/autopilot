/** Desktop 受管入口和设置共用的编排模板；只识别请求的完整首行。 */
export const ORCHESTRATION_TEMPLATES = [
  { id: "handoff", label: "移交任务", description: "把范围、上下文和现有产物移交给新的负责人。" },
  { id: "phased", label: "分阶段执行", description: "按依赖顺序派工，每阶段核对交付后再推进。" },
  { id: "parallel", label: "并行处理", description: "把可独立的步骤一起安排，按目录租约执行。" },
  { id: "review", label: "独立检查", description: "由独立执行者复查已冻结的产物版本并回报。" },
] as const;
export type OrchestrationFlow = typeof ORCHESTRATION_TEMPLATES[number]["id"];
export const ORCHESTRATION_TEMPLATE_COMMAND = "/ap-orchestration";

/** 首行格式与复制按钮使用同一个定义。 */
export function orchestrationTemplateHeader(label: typeof ORCHESTRATION_TEMPLATES[number]["label"]): string {
  return ORCHESTRATION_TEMPLATE_COMMAND + " " + label;
}

/** 完全匹配首行，正文与换行不做重写。 */
export function parseOrchestrationTemplate(content: string): { flow: OrchestrationFlow; body: string } | undefined {
  const newline = content.indexOf("\n");
  const header = (newline < 0 ? content : content.slice(0, newline)).replace(/\r$/u, "");
  const template = ORCHESTRATION_TEMPLATES.find(function exact(item) { return orchestrationTemplateHeader(item.label) === header; });
  if (template) return { flow: template.id, body: newline < 0 ? "" : content.slice(newline + 1) };
}
