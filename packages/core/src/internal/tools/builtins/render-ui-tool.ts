/** Chat none/web 的纯展示工具：校验白名单文档后交给 Runtime 发布安全 ui_document 事件。 */
import { uiDocumentInputSchema, validateUiDocumentInput, type UiDocumentPayload } from "../../../ui/document";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition, ToolExecutionContext } from "../types";
import { z } from "zod";
import {
  UI_COMPONENT_NAMES,
  UI_COMPONENT_SCHEMAS,
  UI_MAX_DOCUMENT_BYTES,
  UI_MAX_ELEMENTS,
  UI_MAX_STATE_BYTES,
  UI_MAX_STATE_KEYS,
  UI_MAX_TREE_DEPTH,
  UI_MAX_CHILDREN,
  UI_MAX_SLOT_CHILDREN,
  UI_MAX_COMPUTED_ITEMS,
  UI_SAVINGS_GROWTH_BOUNDS,
} from "../../../ui/catalog";

const MAX_UI_DOCUMENTS_PER_TURN = 3;

const uiGenerationExamples: UiDocumentPayload[] = [
  {
    title: "当天行程",
    fallbackText: "行程包括准备清单、时段安排和可本地切换的讲解步骤。",
    spec: {
      root: "itinerary",
      state: { currentStep: 0 },
      elements: {
        itinerary: { type: "Stack", props: { direction: "column", gap: 8 }, children: ["preparation", "schedule", "steps", "reset"] },
        preparation: { type: "ItemList", props: { ordered: false, items: [{ title: "确认车票", description: "出发前核对日期和乘车人。" }, { title: "准备证件", description: "携带有效身份证件。" }] } },
        schedule: { type: "Timeline", props: { items: [{ label: "上午", title: "前往车站" }, { label: "下午", title: "办理入住" }] } },
        steps: { type: "Steps", props: { statePath: "currentStep", items: [{ title: "出发前检查" }, { title: "到达后办理入住" }] } },
        reset: { type: "Button", props: { text: "重置本块", action: "reset_state" }, on: { press: { action: "reset_state" } } },
      },
    },
  },
  {
    title: "方案预算对照",
    fallbackText: "可按类别筛选预算行，在本地选择当前关注的方案；选择和排序仅影响当前块。",
    spec: {
      root: "budget",
      state: { selectedPlan: "steady" },
      elements: {
        budget: { type: "Stack", props: { direction: "column", gap: 8 }, children: ["plan-choice", "budget-table", "reset"] },
        "plan-choice": { type: "ChoiceGroup", props: { label: "关注方案", statePath: "selectedPlan", options: [{ value: "steady", label: "稳健方案" }, { value: "growth", label: "增长方案" }] } },
        "budget-table": {
          type: "DataTable",
          props: {
            caption: "月度预算",
            columns: [{ key: "category", label: "类别" }, { key: "plan", label: "方案" }, { key: "amount", label: "金额", align: "right" }],
            rows: [{ category: "固定", plan: "稳健", amount: 800 }, { category: "固定", plan: "增长", amount: 1000 }, { category: "弹性", plan: "稳健", amount: 300 }, { category: "弹性", plan: "增长", amount: 500 }],
            filterColumnKey: "category",
            sortable: true,
          },
        },
        reset: { type: "Button", props: { text: "重置本块", action: "reset_state" }, on: { press: { action: "reset_state" } } },
      },
    },
  },
];

/** 从唯一组件schema生成模型目录说明，不复制另一套允许字段或固定页面模板。 */
function describeUiCatalog(): string {
  const components = Object.fromEntries(UI_COMPONENT_NAMES.map(function entry(name) {
    const { $schema: _schema, ...props } = z.toJSONSchema(UI_COMPONENT_SCHEMAS[name]);
    return [name, props];
  }));
  /** 在提供示例前逐一调用实际 Core 文档校验器，输出仍使用模型输入字段。 */
  const validatedExamples = uiGenerationExamples.map(function validateExample(example) {
    validateUiDocumentInput(example);
    return example;
  });
  return [
    "流程图使用 Flowchart 的 nodes/edges/direction/description，包含真实节点、连线与分支标签，不能把列表/Tabs 命名为流程图；description 提供文字等价说明。节点最多24个、边最多48条，节点/边id唯一且边端点必须存在；节点标签最多40字、边标签最多24字。",
    "用途：当用户能通过本地选择、筛选、排序、步骤讲解或联动比较更有效完成任务时调用；短事实、翻译、普通代码输出或简单解释用文字即可，不要强行生成UI。缺少关键事实时先提问；目录无法表达时用文字说明。只提交完整块，不输出HTML、JS、URL或样式。",
    "外观与布局由本地固定的白名单 registry 和 Design token 控制；只提供目录声明的语义 props 和布局字段，不提供 className、style 或 CSS。只有本工具成功校验后发出的 ui_document 才进入交互展示；普通助手正文、Markdown、JSON 或代码块始终是文本，不要将其改写或执行成 UI。",
    "完整工具输入为{title,fallbackText,spec}：title必填1–80字，fallbackText必填且最多2000字并提供文字等价说明；spec必填且仅含root、elements、可选state。root是elements中的节点ID；elements是动态ID→元素映射，不能改成数组。",
    `每个元素必须有type和props；仅可使用下列${UI_COMPONENT_NAMES.length}类。元素外层可选children、slots、visible、on，不可加其他字段。Stack/Grid/Card可用children（最多${UI_MAX_CHILDREN}个）且不能用slots；Tabs不能用children，只能用slots.items；Disclosure不能用children，只能用slots.content；其他组件不能用children或slots。每个slot最多${UI_MAX_SLOT_CHILDREN}个子节点。Tabs的slots.items按props.items索引对应面板，Disclosure用slots.content承载内容。`,
    "交付前自检：先确定root，只输出由root经children/slots引用的实际节点；elements中的每个键都必须可从root到达，除root外每节点恰由一个children/slots引用。Tabs面板必须通过slots.items引用，Disclosure内容必须通过slots.content引用；删除占位、草稿和未使用节点，并逐项核对elements键与从root遍历所得节点清单一致。无法表达时改用普通文字。",
    "visible是布尔值或单层条件；对象必含$state，最多有一个比较符：eq/neq接字符串、数字、布尔值或state引用；gt/gte/lt/lte只接有限数字或数字state引用；可选not只能为true。$state引用只能指向已声明state的顶层键。元素引用必须组成从root可达的单棵树；不要复用子节点或制造循环。",
    `一次成功调用只交付一个独立UI块；同一Turn可按主题需要重复调用，0到${MAX_UI_DOCUMENTS_PER_TURN}个块，每块有自己的标题、身份和局部状态。强关联且需要共同状态的内容放在同一块；行程、预算等独立主题可分次调用，不为换样式、分章节或凑数量拆块。服务端上限还包括每块${UI_MAX_DOCUMENT_BYTES}字节、${UI_MAX_ELEMENTS}个节点、深度${UI_MAX_TREE_DEPTH}；state最多${UI_MAX_STATE_KEYS}个number/string/boolean键且最多${UI_MAX_STATE_BYTES}字节。服务端继续校验跨节点引用、循环/重复/不可达节点、所有限额、有限数值、计算范围和权限。`,
    "将需要即时反馈的输入、选择与结果留在同一块，使用已声明的标量state和本地白名单组件联动；不要为本地交互追加模型调用。NumberInput/Slider/Select/Steps/ChoiceGroup的props.statePath填写已声明state的普通顶层键；Steps初值须为0起且小于步骤数的整数，ChoiceGroup选项值须唯一且初值须匹配一个选项。Button.props.fields[].statePath也必须指向已声明键。Core会将statePath归一成renderer绑定。动态Text.value可用{$state:'/key'}；Metric.value可用数字、{$state:'/key'}或受限计算。",
    `计算只用Core注册函数：savingsGrowth要求args包含P/C/R/Y/select，P为${UI_SAVINGS_GROWTH_BOUNDS.P.min}..${UI_SAVINGS_GROWTH_BOUNDS.P.max}、C为${UI_SAVINGS_GROWTH_BOUNDS.C.min}..${UI_SAVINGS_GROWTH_BOUNDS.C.max}、R为名义年利率${UI_SAVINGS_GROWTH_BOUNDS.R.min}..${UI_SAVINGS_GROWTH_BOUNDS.R.max}、Y为${UI_SAVINGS_GROWTH_BOUNDS.Y.min}..${UI_SAVINGS_GROWTH_BOUNDS.Y.max}整数；参数可写有限数字或已声明state引用。select='final'只用于Metric.value，select='series'只用于LineChart/BarChart.series。sum用args.values数组，weightedAverage用args.pairs数组，最多${UI_MAX_COMPUTED_ITEMS}项；二者只接受非负有限数字或state引用，Core验证引用和正权重。`,
    "Button只支持两个本地白名单动作：continue_chat必须同时写props.action与元素外层on:{press:{action:'continue_chat'}}，并用fields列出已声明state键；reset_state仅写props:{action:'reset_state',text}并同步外层on:{press:{action:'reset_state'}}，不得加fields。两处缺一或不一致都不合法；不要省略、替换、自动推断或添加其他事件。continue_chat提交固定格式的普通新消息，不是工具授权；reset_state只重置当前块且不发送消息。",
    "组件按任务选择：ItemList表达清单，Timeline按给定顺序表达事件而不猜测日期或进度，Steps供用户本地切换讲解步骤且不代表Agent执行进度，ChoiceGroup表达少量单选；DataTable适合精确对照，filterColumnKey须指向已声明且各行都有值的同类型字符串/数值列，sortable:true只对同类型字符串/数值列提供本地排序。Tabs只用于确有分层内容需要切换时，图表只用于趋势或类别比较能增加信息时，不要强行使用Tabs或图表。Stack/Grid/Card/Text/Metric与输入控件用于组合和解释。普通事实直接文字。按任务组合，不把样例扩成固定页面。",
    "组件props的必填项、类型、枚举与数组边界由同源Core schema自动附在下面；不要添加schema之外的props。可组合方向：讲解=Text+Tabs/Disclosure；比较=Grid+Card+DataTable，必要时加Select；计算=输入控件+Metric/Chart+注册函数。",
    "以下两个最小输入例分别展示行程与预算这类独立任务；只有回答确实覆盖两个主题时才可在同一Turn分别调用，不要把样例扩成固定页面。每个例子都会交给同一个validateUiDocumentInput Core validator校验。展示的是模型输入格式（包括statePath），不是归一后的renderer格式：",
    JSON.stringify(validatedExamples, null, 2),
    "组件props JSON Schema：",
    JSON.stringify(components),
    "无法安全表达时改用普通文字，不因INVALID_INPUT自动修复、重试或放宽目录。",
  ].join("\n");
}

const uiCatalogDescription = describeUiCatalog();
const builtInRenderUiDefinitions = new WeakSet<object>();
export const UI_INPUT_FALLBACK_MESSAGE = "交互内容不符合安全组件契约，请改用普通文字说明";

/** 仅识别本模块实际创建的内置定义，不以工具名或错误码授予恢复资格。 */
export function isBuiltInRenderUiDefinition(definition: object): boolean {
  return builtInRenderUiDefinitions.has(definition);
}

/** 创建受限 UI 工具；安全文档经 callback 进入 Core 事件流，模型只收到有限确认。 */
export function createRenderUiTool(onDocument: (callId: string, document: UiDocumentPayload) => void, publishedCallIds: readonly string[] = []): AgentToolDefinition<{
  title: string;
  fallbackText: string;
  spec: unknown;
}, { delivered: true }> {
  const seenCallIds = new Set(publishedCallIds);
  const definition: AgentToolDefinition<{ title: string; fallbackText: string; spec: unknown }, { delivered: true }> = {
    name: "render_ui",
    description: `在当前 Chat 消息中交付一份白名单交互说明或计算块。\n${uiCatalogDescription}`,
    inputSchema: uiDocumentInputSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
    /** 生成不含模型文档原文的受限动作事实。 */
    createActionFacts() {
      return { toolName: "render_ui", effect: "none", destructive: false, operation: "交付经校验的交互内容" };
    },
    /** 校验并收集完整文档，模型只收到有限成功标记。 */
    async execute(input, context: ToolExecutionContext) {
      const callId = context.toolCallId;
      if (typeof callId !== "string" || !callId) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "交互内容无法关联到当前工具调用");
      if (seenCallIds.has(callId)) return { delivered: true };
      if (seenCallIds.size >= MAX_UI_DOCUMENTS_PER_TURN) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "本轮交互内容数量已达上限");
      let document: UiDocumentPayload;
      try {
        document = validateUiDocumentInput(input);
      } catch {
        throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, UI_INPUT_FALLBACK_MESSAGE);
      }
      onDocument(callId, document);
      seenCallIds.add(callId);
      return { delivered: true };
    },
    /** 只序列化有限确认，不把文档副本回送 Provider。 */
    serializeOutput(output) {
      return { delivered: output.delivered };
    },
  };
  builtInRenderUiDefinitions.add(definition);
  return definition;
}
