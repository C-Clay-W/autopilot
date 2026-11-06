/** Intelligent UI 的本地输入控件与共享绑定；写入前复用 Core 文档校验。 */
"use client";

import { useBoundProp, useStateStore } from "@json-render/react";
import { useContext, useId, useState, type ChangeEvent } from "react";
import { projectUiDocument, type UiScalar } from "@autopilot-agent/core/ui";
import { readNumericInput } from "../computed-functions";
import { UiDocumentContext, type InteractiveUiProps } from "../context";

export const controlClass = "min-w-0 w-full border-2 border-ink bg-bg px-2 py-1.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** 复用当前 json-render store，并在更新前验证整份当前文档。 */
export function useSafeBinding(props: InteractiveUiProps) {
  const [value, setValue] = useBoundProp<UiScalar>(props.element.props.value as UiScalar, props.bindings?.value);
  const store = useStateStore();
  const document = useContext(UiDocumentContext);

  /** 拒绝超范围、非法枚举或非整数步骤，并保留上一次有效状态。 */
  function update(next: UiScalar): boolean {
    const path = props.bindings?.value;
    if (!path || !document) return false;
    const key = path.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
    try {
      projectUiDocument({ ...document, spec: { ...document.spec, state: { ...store.getSnapshot(), [key]: next } } });
    } catch {
      return false;
    }
    setValue(next);
    return true;
  }

  return { value, update };
}

/** 原生 number/range 保持键盘语义；非法输入只保留草稿，不写入计算状态。 */
function NumericInput(props: InteractiveUiProps) {
  const { element } = props;
  const { label, min, max, step, suffix } = element.props as { label: string; min: number; max: number; step: number; suffix?: string };
  const { value, update } = useSafeBinding(props);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  const slider = element.type === "Slider";

  /** 暂存输入并只提交合法有限数值。 */
  function change(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.currentTarget.value;
    if (!slider) setDraft(raw);
    const next = readNumericInput(raw, min, max, step);
    setInvalid(next === undefined || !update(next));
  }

  /** 失焦后清除无效草稿并回到最近一次有效值。 */
  function blur() {
    setDraft(undefined);
    setInvalid(false);
  }

  return <div className="min-w-0 flex-1"><label htmlFor={id} className="mb-1 block text-xs font-semibold">{label}{suffix ? `（${suffix}）` : ""}</label><input id={id} type={slider ? "range" : "number"} min={min} max={max} step={step} value={draft ?? Number(value)} onChange={change} onBlur={blur} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} className={slider ? "w-full accent-accent focus-visible:outline-2 focus-visible:outline-accent" : controlClass} />{slider && <output htmlFor={id} className="block text-xs tabular-nums text-muted">{String(value)}{suffix}</output>}{invalid && <p id={`${id}-error`} className="mt-1 text-xs text-error">请输入范围 {min}–{max} 内、步长为 {step} 的有效数值。</p>}</div>;
}

/** Select 用选项索引传输交互事件，保留 state 中字符串、数字和布尔值的原类型。 */
function Select(props: InteractiveUiProps) {
  const { value, update } = useSafeBinding(props);
  const options = props.element.props.options as Array<{ value: UiScalar; label: string }>;
  const id = useId();

  /** 只把声明过的选项值写入当前块。 */
  function change(event: ChangeEvent<HTMLSelectElement>) {
    const option = options[Number(event.currentTarget.value)];
    if (option) update(option.value);
  }

  return <div className="min-w-0"><label htmlFor={id} className="mb-1 block text-xs font-semibold">{String(props.element.props.label)}</label><select id={id} value={options.findIndex(function selected(option) { return option.value === value; })} onChange={change} className={controlClass}>{options.map(function option(item, index) { return <option key={index} value={index}>{item.label}</option>; })}</select></div>;
}

/** 以原生 radio 组提供卡片式单选，并保留选项的标量类型。 */
function ChoiceGroup(props: InteractiveUiProps) {
  const { value, update } = useSafeBinding(props);
  const options = props.element.props.options as Array<{ value: UiScalar; label: string; description?: string }>;
  const id = useId();

  /** 选择某个目录选项，只更新本块绑定状态。 */
  function change(event: ChangeEvent<HTMLInputElement>) {
    const option = options[Number(event.currentTarget.value)];
    if (option) update(option.value);
  }

  return <fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-sm font-semibold">{String(props.element.props.label)}</legend>{options.map(function choice(option, index) {
    const selected = option.value === value;
    return <label key={index} className={`flex cursor-pointer gap-3 border-2 border-ink p-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${selected ? "bg-accent text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}><input type="radio" name={id} value={index} checked={selected} onChange={change} className="mt-1 h-4 w-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" /><span className="min-w-0"><span className="block break-words font-semibold">{option.label}</span>{option.description && <span className={`mt-1 block break-words text-xs ${selected ? "text-ink-on-dark" : "text-muted"}`}>{option.description}</span>}</span></label>;
  })}</fieldset>;
}

export { ChoiceGroup, NumericInput, Select };
