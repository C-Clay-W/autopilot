/** @autopilot-agent/core/ui — Intelligent UI 的无 DOM 白名单校验与纯函数计算入口。 */
export { UI_COMPONENT_NAMES, UI_COMPONENT_SCHEMAS, UI_COMPUTED_FUNCTION_NAMES, UI_COMPUTED_FUNCTIONS } from "./catalog";
export { UI_DOCUMENT_SCHEMA_VERSION, createUiDocument, projectUiDocument, uiDocumentInputSchema, validateUiDocumentInput } from "./document";
export type { UiComponentName, UiElement, UiScalar, UiSpec, UiState } from "./catalog";
export type { UiDocument, UiDocumentPayload } from "./document";
