/** 仅用于合成A/B比较smoke：复用Core投影和renderer可见性，只返回固定布尔与规则码。 */
import { projectUiDocument, type UiDocument, type UiScalar } from "@autopilot-agent/core/ui";
import { evaluateVisibility, getByPath, type VisibilityCondition } from "@json-render/core";

/** 比较合成事实与选择联动，不约束Grid/Card或节点ID，不输出文案/state。 */
export function checkS3Comparison(input: UiDocument) {
  const document = projectUiDocument(input);
  const { elements, state = {} } = document.spec;
  const checks = { selection: false, conditionalExplanation: false, facts: false, continuation: false };

  /** 沿Core已校验的树应用真实renderer条件，包括父节点隐藏。 */
  function visibleIds(nextState: Record<string, UiScalar>): Set<string> {
    const ids = new Set<string>();
    /** 只访问当前可见子树，不另写条件解析器。 */
    function visit(id: string): void {
      const element = elements[id];
      if (!evaluateVisibility(element.visible as VisibilityCondition | undefined, { stateModel: nextState })) return;
      ids.add(id);
      for (const child of [...(element.children ?? []), ...Object.values(element.slots ?? {}).flat()]) visit(child);
    }
    visit(document.spec.root);
    return ids;
  }

  /** 从合成题给定的A/B身份读取标签，允许前缀、空白及附加说明。 */
  function optionName(value: unknown): string {
    return typeof value === "string" ? value.trim().match(/^(?:(?:方案|选项|option|plan)\s*)?([ab])(?:$|[\s（(:：-])/i)?.[1].toUpperCase() ?? "" : "";
  }

  for (const [id, element] of Object.entries(elements)) {
    if (element.type !== "Select") continue;
    const options = element.props.options as Array<{ label: string; value: UiScalar }>;
    const a = options.find(function isA(option) { return optionName(option.label) === "A"; });
    const b = options.find(function isB(option) { return optionName(option.label) === "B"; });
    const binding = element.props.value as { $bindState: string };
    const key = binding.$bindState.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!a || !b || a.value === b.value || options.length !== 2) continue;
    const aIds = visibleIds({ ...state, [key]: a.value });
    const bIds = visibleIds({ ...state, [key]: b.value });
    if (!aIds.has(id) || !bIds.has(id)) continue;
    checks.selection = true;
    /** 两个选择各有非空、互斥的说明，避免只有静态文本或无效visible。 */
    function hasOwnExplanation(own: Set<string>, other: Set<string>, nextState: Record<string, UiScalar>): boolean {
      return [...own].some(function explanation(nodeId) {
        const node = elements[nodeId];
        if (other.has(nodeId) || node.type !== "Text") return false;
        const value = typeof node.props.value === "string" ? node.props.value : getByPath(nextState, (node.props.value as { $state: string }).$state);
        return typeof value === "string" && value.trim().length > 0;
      });
    }
    checks.conditionalExplanation = hasOwnExplanation(aIds, bIds, { ...state, [key]: a.value }) && hasOwnExplanation(bIds, aIds, { ...state, [key]: b.value });
    checks.continuation = Object.entries(elements).some(function continuation([buttonId, button]) {
      return button.type === "Button" && aIds.has(buttonId) && bIds.has(buttonId)
        && button.props.action === "continue_chat"
        && (button.props.fields as Array<{ statePath: string }>).some(function selectedField(field) { return field.statePath === key; });
    });
    checks.facts = Object.entries(elements).some(function facts([tableId, table]) {
      if (table.type !== "DataTable" || !aIds.has(tableId) || !bIds.has(tableId)) return false;
      const rows = table.props.rows as Array<Record<string, string | number>>;
      const columns = table.props.columns as Array<{ key: string; label: string }>;
      if (rows.length !== 2 || columns.length < 3) return false;
      const nameColumn = columns.find(function names(column) { return rows.some(function rowA(row) { return optionName(row[column.key]) === "A"; }) && rows.some(function rowB(row) { return optionName(row[column.key]) === "B"; }); });
      if (!nameColumn) return false;
      const rowA = rows.find(function namedA(row) { return optionName(row[nameColumn.key]) === "A"; })!;
      const rowB = rows.find(function namedB(row) { return optionName(row[nameColumn.key]) === "B"; })!;
      return columns.some(function prices(column) { return /价格|售价|费用|成本|price|cost/i.test(column.label) && Number(rowA[column.key]) === 100 && Number(rowB[column.key]) === 150; })
        && columns.some(function performance(column) { return /性能|效能|评分|performance|score/i.test(column.label) && Number(rowA[column.key]) === 80 && Number(rowB[column.key]) === 95; });
    });
    // 所有功能须属于同一个选择控件，不能拼接无关控件的部分通过结果。
    if (Object.values(checks).every(Boolean)) break;
  }
  const rules = ["COMPARISON_SELECTION_MISSING", "COMPARISON_VISIBLE_EXPLANATION_MISSING", "COMPARISON_FACTS_MISMATCH", "COMPARISON_CONTINUATION_FIELD_MISSING"] as const;
  const failureCode = rules[Object.values(checks).findIndex(function failed(value) { return !value; })];
  return { ...checks, passed: !failureCode, ...(failureCode ? { failureCode } : {}) };
}

