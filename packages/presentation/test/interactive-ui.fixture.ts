/** S2 共享储蓄夹具：只提供模型可组合 spec 数据，不是产品固定页面模板。 */
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import { createUiDocument, validateUiDocumentInput } from "@autopilot-agent/core/ui";

/** 生成包含四个参数、局部选择、数值、图表、说明与禁用续聊动作的完整安全文档。 */
export function createSavingsFixture() {
  const args = { P: { $state: "/principal" }, C: { $state: "/monthly" }, R: { $state: "/rate" }, Y: { $state: "/years" } };
  return createUiDocument(validateUiDocumentInput({
    title: "储蓄增长探索",
    fallbackText: "初始本金1000元，每月月末投入100元，名义年利率0%，持续2年，期末余额3400元。",
    spec: {
      root: "root", state: { principal: 1000, monthly: 100, rate: 0, years: 2, view: "detail" },
      elements: {
        root: { type: "Stack", props: { direction: "column", gap: 16 }, children: ["intro", "card", "result", "tabs", "continue"] },
        intro: { type: "Text", props: { value: "按名义年利率估算，每月月末投入；结果不代表收益承诺。", size: "sm", tone: "muted" } },
        card: { type: "Card", props: { title: "调整参数" }, children: ["grid"] },
        grid: { type: "Grid", props: { columns: 2, gap: 12 }, children: ["principal", "monthly", "rate", "years", "view"] },
        principal: { type: "NumberInput", props: { label: "初始本金", statePath: "principal", min: 0, max: 100000, step: 100, suffix: "元" } },
        monthly: { type: "NumberInput", props: { label: "每月投入", statePath: "monthly", min: 0, max: 10000, step: 100, suffix: "元" } },
        rate: { type: "Slider", props: { label: "名义年利率", statePath: "rate", min: 0, max: 0.3, step: 0.001 } },
        years: { type: "Slider", props: { label: "年数", statePath: "years", min: 1, max: 60, step: 1, suffix: "年" } },
        view: { type: "Select", props: { label: "说明", statePath: "view", options: [{ value: "detail", label: "显示计算口径" }, { value: "compact", label: "简洁" }] } },
        result: { type: "Metric", props: { label: "期末余额", value: { $computed: "savingsGrowth", args: { ...args, select: "final" } }, unit: "元", tone: "accent" } },
        tabs: { type: "Tabs", props: { items: [{ key: "trend", label: "增长趋势" }, { key: "notes", label: "计算口径" }] }, slots: { items: ["chart", "disclosure"] } },
        chart: { type: "LineChart", props: { title: "逐年余额", xLabel: "年数", yLabel: "余额", unit: "元", series: { $computed: "savingsGrowth", args: { ...args, select: "series" } } } },
        disclosure: { type: "Disclosure", props: { summary: "查看说明", defaultOpen: true }, slots: { content: ["assumption", "table", "bar"] } },
        assumption: { type: "Text", props: { value: "月利率=名义年利率/12，未计税费与通胀。", size: "xs", tone: "muted" }, visible: { $state: "/view", eq: "detail" } },
        table: { type: "DataTable", props: { columns: [{ key: "year", label: "年数" }, { key: "amount", label: "零利率余额", align: "right" }], rows: [{ year: 0, amount: 1000 }, { year: 1, amount: 2200 }, { year: 2, amount: 3400 }], caption: "初始参数示例，动态结果见增长趋势" } },
        bar: { type: "BarChart", props: { title: "初始年度示例", series: [{ name: "零利率余额", points: [{ x: 0, y: 1000 }, { x: 1, y: 2200 }, { x: 2, y: 3400 }] }] } },
        continue: { type: "Button", props: { action: "continue_chat", text: "按当前参数继续分析", fields: [{ label: "本金", statePath: "principal" }, { label: "月投入", statePath: "monthly" }, { label: "利率", statePath: "rate" }, { label: "年数", statePath: "years" }] }, on: { press: { action: "continue_chat" } } },
      },
    },
  }), `ui_${"0".repeat(32)}`);
}

/** 构造可复用的安全 Runtime 信封，测试不启动真实 Provider 或宿主。 */
export function uiEnvelope(seq: number, event: AgentEvent, turnId = "turn-ui", sessionId = "session-ui"): AgentEventEnvelope {
  return { seq, sessionId, turnId, timestamp: `2026-10-25T08:00:${String(seq).padStart(2, "0")}.000Z`, event };
}

/** 同一步的前文、UI、后文与 reset/终态，验证块不会被回答生命周期吞掉。 */
export function createUiEnvelopes(): AgentEventEnvelope[] {
  return [
    uiEnvelope(0, { type: "turn_started", turnId: "turn-ui", stepCount: 0 } as AgentEvent),
    uiEnvelope(1, { type: "answer_delta", turnId: "turn-ui", stepId: "step-ui", delta: "前文" }),
    uiEnvelope(2, { type: "ui_document", turnId: "turn-ui", stepId: "step-ui", callId: "call-ui", document: createSavingsFixture() }),
    uiEnvelope(3, { type: "answer_delta", turnId: "turn-ui", stepId: "step-ui", delta: "后文" }),
    uiEnvelope(4, { type: "answer_reset", turnId: "turn-ui", stepId: "step-ui" }),
    uiEnvelope(5, { type: "answer_delta", turnId: "turn-ui", stepId: "step-next", delta: "总结" }),
    uiEnvelope(6, { type: "turn_completed", turnId: "turn-ui", checkpoint: {} } as AgentEvent),
  ];
}
