/** Presentation 的通用文本脱敏与限长工具；仅处理 Host 可展示文本，绝不回读工具原始输入或输出。 */

const SECRET_PATTERN = /((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s]+/gi;

/** 遮蔽常见凭据片段，避免 Host 安全摘要意外携带访问令牌。 */
export function redactPresentationText(value: string): string {
  return value.replace(SECRET_PATTERN, "$1[REDACTED]").replace(BEARER_PATTERN, "Bearer [REDACTED]");
}

/** 先脱敏再按字符数截断，保证提示性文本不会无界进入视图模型。 */
export function truncatePresentationText(value: string, maxLength = 240): string {
  const redacted = redactPresentationText(value);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, Math.max(0, maxLength - 1))}…`;
}
