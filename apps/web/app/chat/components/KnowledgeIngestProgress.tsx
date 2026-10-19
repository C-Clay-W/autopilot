/**
 * KnowledgeIngestProgress.tsx —— 展示 Core ingest 回调投影出的真实上传与入库进度。
 */

import type { KnowledgeIngestProgress as CoreIngestProgress } from "@/lib/knowledge-ingest-client";
import type { ProcessStep } from "./process-step";

/** 读取 Core 进度中的有效正整数，避免异常计数破坏展示。 */
function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 将分块索引补成面向用户的一基进度，并优先使用 Core 已提供的 current/total。 */
function readProgressCounter(event: CoreIngestProgress): { current?: number; total?: number } {
  const total = readPositiveNumber(event.total) ?? readPositiveNumber(event.totalChunks);
  const current = readPositiveNumber(event.current)
    ?? (typeof event.chunkIndex === "number" && Number.isInteger(event.chunkIndex) && event.chunkIndex >= 0 ? event.chunkIndex + 1 : undefined);
  return { current, total };
}

/** 使用 Core 的安全 message 作为主要文案，仅对会泄漏内部表名的写入阶段使用固定文案。 */
function readProgressMessage(event: CoreIngestProgress, fallback: string): string {
  return typeof event.message === "string" && event.message.trim() ? event.message.trim() : fallback;
}

/** 将 Core ingest step 映射为稳定的 UI 阶段，同时保留真实页级 current/total。 */
export function getKnowledgeIngestProcessStep(event: CoreIngestProgress): ProcessStep {
  const counter = readProgressCounter(event);
  switch (event.step) {
    case "parse_start":
    case "parse":
    case "parse_page":
      return { stage: "parse", message: readProgressMessage(event, "正在解析文件"), ...counter };
    case "text_parse_page":
      return { stage: "text-parse", message: readProgressMessage(event, "正在提取页面文本"), ...counter };
    case "image_render_page":
      return { stage: "image-render", message: readProgressMessage(event, "正在渲染页面图片"), ...counter };
    case "page_merge":
      return { stage: "page-merge", message: readProgressMessage(event, "正在合并页面内容"), ...counter };
    case "chunk_row":
    case "chunk_item":
    case "chunk_complete":
      return { stage: "chunk", message: readProgressMessage(event, "正在整理内容分块"), ...counter };
    case "page_embed_item":
    case "embed":
      return { stage: "embed", message: readProgressMessage(event, "正在生成检索索引"), ...counter };
    case "write":
    case "write_pages":
      return { stage: "write", message: "正在写入知识库" };
    case "done":
      return { stage: "done", message: readProgressMessage(event, "入库处理完成"), ...counter };
    case "error":
      return { stage: "error", message: readProgressMessage(event, "入库处理失败"), ...counter };
    default:
      return { stage: event.step || "prepare", message: readProgressMessage(event, "正在准备入库"), ...counter };
  }
}

/** 将当前阶段的真实计数换算为 0–100 的可展示百分比。 */
function getProgressPercentage(step: ProcessStep | undefined): number | undefined {
  if (!step?.current || !step.total) return undefined;
  return Math.max(0, Math.min(100, Math.round((step.current / step.total) * 100)));
}

/** 渲染仅属于 RAG 入库的当前阶段；扫光持续反馈运行状态，文案随 Core 事件原位更新。 */
export default function KnowledgeIngestProgress({ steps }: { steps: ProcessStep[] }) {
  const currentStep: ProcessStep = steps[steps.length - 1] ?? { stage: "prepare", message: "正在准备上传文件" };
  const percentage = getProgressPercentage(currentStep);
  const counter = currentStep.current && currentStep.total ? `${currentStep.current}/${currentStep.total}` : undefined;

  return (
    <section className="w-full min-w-[min(32rem,72vw)] border-2 border-ink bg-card px-4 py-3" role="status" aria-live="polite" aria-label="知识库入库进度">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <span className="inline-block w-3 shrink-0 text-center font-bold text-accent" aria-hidden="true">*</span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold">正在加入知识库</h3>
            <p className="mt-1 text-xs text-muted">{currentStep.message}</p>
          </div>
        </div>
        {counter && <span className="shrink-0 text-xs font-bold text-ink">{counter}{percentage !== undefined ? ` · ${percentage}%` : ""}</span>}
      </div>

      <div
        className="mt-3 h-1 overflow-hidden bg-ink/10"
        role="progressbar"
        aria-label="当前入库阶段进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
        aria-valuetext={counter ? `${currentStep.message}，${counter}` : currentStep.message}
      >
        <div className="knowledge-ingest-sweep h-full w-1/3 bg-accent" aria-hidden="true" />
      </div>
    </section>
  );
}
