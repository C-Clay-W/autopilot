/** process-step.ts — 定义实时与历史过程步骤的数据结构，不包含活动动画或展示逻辑。 */

/** Agent 过程步骤；diffContent 仅用于历史 inline diff 展示。 */
export interface ProcessStep {
  stage: string;
  message: string;
  current?: number;
  total?: number;
  diffContent?: string;
}
