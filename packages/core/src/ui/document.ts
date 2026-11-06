/** Intelligent UI 的模型输入、安全文档事件类型与纯 JSON 文档投影。 */
import { z } from "zod";
import { measureUiJsonBytes, uiSpecInputSchema, UI_MAX_DOCUMENT_BYTES, validateNormalizedUiSpec, validateUiSpec, type UiSpec } from "./catalog";

export const UI_DOCUMENT_SCHEMA_VERSION = 1 as const;

export interface UiDocumentPayload {
  title: string;
  fallbackText: string;
  spec: UiSpec;
}

export interface UiDocument extends UiDocumentPayload {
  schemaVersion: typeof UI_DOCUMENT_SCHEMA_VERSION;
  uiId: string;
}

export const uiDocumentInputSchema = z.object({
  title: z.string().min(1).max(80),
  fallbackText: z.string().max(2000),
  spec: uiSpecInputSchema,
}).strict();

const projectedUiDocumentSchema = z.object({
  schemaVersion: z.literal(UI_DOCUMENT_SCHEMA_VERSION),
  uiId: z.string().regex(/^ui_[a-f0-9]{32}$/),
  title: z.string().min(1).max(80),
  fallbackText: z.string().max(2000),
  spec: z.unknown(),
}).strict();

/** 校验模型给出的完整文档，应用有界组件契约并转换输入控件 statePath。 */
export function validateUiDocumentInput(value: unknown): UiDocumentPayload {
  measureUiJsonBytes(value, UI_MAX_DOCUMENT_BYTES);
  const input = uiDocumentInputSchema.parse(value);
  const payload: UiDocumentPayload = {
    title: input.title,
    fallbackText: input.fallbackText,
    spec: validateUiSpec(input.spec),
  };
  createUiDocument(payload, `ui_${"0".repeat(32)}`);
  return payload;
}

/** 生成包含 Core 派生 uiId 的事件文档，并确认最终投影仍处于 64 KiB 上限内。 */
export function createUiDocument(payload: UiDocumentPayload, uiId: string): UiDocument {
  return projectUiDocument({ schemaVersion: UI_DOCUMENT_SCHEMA_VERSION, uiId, ...payload });
}

/** 对已校验文档做字段白名单投影，切断调用方对象别名并拒绝非 JSON 内容。 */
export function projectUiDocument(value: unknown): UiDocument {
  measureUiJsonBytes(value, UI_MAX_DOCUMENT_BYTES);
  const document = projectedUiDocumentSchema.parse(value);
  const spec = document.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new Error("UI spec 投影不合法");
  const clone = JSON.parse(JSON.stringify(validateNormalizedUiSpec(spec))) as UiSpec;
  return {
    schemaVersion: UI_DOCUMENT_SCHEMA_VERSION,
    uiId: document.uiId,
    title: document.title,
    fallbackText: document.fallbackText,
    spec: clone,
  };
}
