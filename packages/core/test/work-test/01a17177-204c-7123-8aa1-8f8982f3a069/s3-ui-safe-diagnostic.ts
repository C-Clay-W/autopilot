/** S3 测试辅助：把 UI 校验拒绝压缩为不含原值的有限诊断。 */

interface SafeValidationIssue {
  path: PropertyKey[];
  code: string;
  expected?: unknown;
}

interface SafeParseSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: SafeValidationIssue[] } };
}

interface SafeFinding {
  path: string;
  expectedRule: string;
  valueCategory: string;
}

export interface SafeUiDiagnostic {
  valid: boolean;
  rule: string;
  findings: SafeFinding[];
  findingsTruncated: boolean;
}

const MAX_DIAGNOSTIC_ELEMENTS = 128;
const MAX_DIAGNOSTIC_FINDINGS = 16;
const KNOWN_EXPECTED_TYPES = new Set(["array", "bigint", "boolean", "function", "int", "nan", "never", "null", "number", "object", "string", "symbol", "undefined"]);

/** 判断非数组对象，避免把任意对象属性写进安全诊断。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只报告 JavaScript 值类别，不保留输入内容。 */
function valueCategory(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "undefined") return "missing";
  return typeof value === "object" ? "object" : "other";
}

/** 沿 Zod 字段路径只读数据属性，避免诊断意外触发输入访问器。 */
function valueAtPath(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const part of path) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    const key = typeof part === "symbol" ? undefined : String(part);
    if (key === undefined) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}

/** 读取拥有的数据字段；访问器一律视作缺失。 */
function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** 替换动态 map 键并编码固定字段，避免 ID、state 键或表格单元字段泄漏。 */
function safePath(path: PropertyKey[]): string {
  return `/${path.map(function segment(part, index) {
    const previous = path[index - 1];
    const beforePrevious = path[index - 2];
    if (previous === "elements" || previous === "state" || (typeof previous === "number" && beforePrevious === "rows")) return "*";
    const value = typeof part === "symbol" ? "*" : String(part);
    return value.replace(/~/g, "~0").replace(/\//g, "~1");
  }).join("/")}`;
}

/** 将 Zod issue 转成不含动态 message 或输入字段名的固定规则类别。 */
function expectedRule(issue: SafeValidationIssue): string {
  if (issue.code === "invalid_type") {
    return typeof issue.expected === "string" && KNOWN_EXPECTED_TYPES.has(issue.expected) ? `type:${issue.expected}` : "schema-type";
  }
  if (issue.code === "unrecognized_keys") return "known-fields-only";
  if (issue.code === "too_small") return "schema-minimum";
  if (issue.code === "too_big") return "schema-maximum";
  if (issue.code === "invalid_format") return "schema-format";
  if (issue.code === "invalid_value") return "allowed-literal-or-enum";
  if (issue.code === "invalid_union") return "schema-union-match";
  if (issue.code === "not_multiple_of") return "schema-multiple";
  return "schema-constraint";
}

/** 从已知 Core 规则映射安全代码，绝不回传未知异常文本。 */
function coreRule(error: unknown): string {
  if (!isRecord(error) || typeof error.message !== "string") return "core-semantic-constraint";
  const rules: Record<string, string> = {
    "UI props 不符合组件目录": "component-props-schema",
    "输入控件 min/max/step 不合法": "input-range",
    "输入控件初始值超出范围": "input-initial-value-range",
    "UI 节点包含未知字段": "element-known-fields-only",
    "UI component 不在白名单中": "component-whitelist",
    "UI 引用悬空": "tree-reference-exists",
    "UI 节点不得被重复引用": "tree-node-unique",
    "UI elements 含不可达节点": "tree-all-nodes-reachable",
    "计算参数超出范围": "computed-argument-range",
    "Button 仅支持 on.press": "button-action-binding",
    "只有 Button 可以绑定动作": "button-only-action",
    "state 引用未声明": "state-reference-declared",
  };
  return Object.prototype.hasOwnProperty.call(rules, error.message) ? rules[error.message]! : "core-semantic-constraint";
}

/** 执行当前 Core validator 并仅返回占位路径、固定规则和值类别。 */
export function diagnoseUiDocumentInput(
  input: unknown,
  validate: (value: unknown) => unknown,
  componentSchemas: Record<string, SafeParseSchema>,
): SafeUiDiagnostic {
  try {
    validate(input);
    return { valid: true, rule: "accepted", findings: [], findingsTruncated: false };
  } catch (error) {
    const findings: SafeFinding[] = [];
    const issueList = isRecord(error) && Array.isArray(error.issues) ? error.issues as SafeValidationIssue[] : [];
    for (const issue of issueList) {
      if (!issue || !Array.isArray(issue.path) || typeof issue.code !== "string") continue;
      findings.push({ path: safePath(issue.path), expectedRule: expectedRule(issue), valueCategory: valueCategory(valueAtPath(input, issue.path)) });
    }

    const specValue = valueAtPath(input, ["spec"]);
    const spec = isRecord(specValue) ? specValue : undefined;
    const elementsValue = spec ? ownDataValue(spec, "elements") : undefined;
    const elementEntries = isRecord(elementsValue)
      ? Object.keys(elementsValue).slice(0, MAX_DIAGNOSTIC_ELEMENTS).map(function element(key) {
        return { key, value: ownDataValue(elementsValue, key) };
      })
      : [];
    for (const entry of elementEntries) {
      const element = entry.value;
      if (!isRecord(element)) continue;
      const type = ownDataValue(element, "type");
      if (typeof type !== "string") continue;
      if (!Object.prototype.hasOwnProperty.call(componentSchemas, type)) {
        findings.push({ path: "/spec/elements/*/type", expectedRule: "component-whitelist", valueCategory: valueCategory(type) });
        continue;
      }
      const props = ownDataValue(element, "props");
      const parsed = componentSchemas[type]!.safeParse(props);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (!issue || !Array.isArray(issue.path) || typeof issue.code !== "string") continue;
          findings.push({
            path: safePath(["spec", "elements", "*", "props", ...issue.path]),
            expectedRule: expectedRule(issue),
            valueCategory: valueCategory(valueAtPath(props, issue.path)),
          });
        }
      }
    }

    const uniqueFindings = [...new Map(findings.map(function unique(finding) { return [`${finding.path}\0${finding.expectedRule}\0${finding.valueCategory}`, finding] as const; })).values()];
    if (!uniqueFindings.length) uniqueFindings.push({ path: "/spec", expectedRule: coreRule(error), valueCategory: valueCategory(spec) });
    return {
      valid: false,
      rule: issueList.length ? "schema-rejected" : coreRule(error),
      findings: uniqueFindings.slice(0, MAX_DIAGNOSTIC_FINDINGS),
      findingsTruncated: uniqueFindings.length > MAX_DIAGNOSTIC_FINDINGS,
    };
  }
}
