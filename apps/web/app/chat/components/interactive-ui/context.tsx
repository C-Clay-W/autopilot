/** Intelligent UI 展示实例共享的安全文档、绑定类型和块级上下文。 */
"use client";

import { createContext } from "react";
import type { ComponentRenderProps } from "@json-render/react";
import type { UiDocument } from "@autopilot-agent/core/ui";
import type { UiContinuation, UiContinueTarget } from "./continue-chat";

/** json-render 白名单组件使用的统一渲染属性。 */
export type InteractiveUiProps = ComponentRenderProps;

/** 图表序列的归一化展示类型。 */
export type ChartSeries = Array<{ name: string; points: Array<{ x: number; y: number | null }> }>;

/** 图表及其数据表共用的展示属性。 */
export interface ChartProps {
  type: "LineChart" | "BarChart";
  title?: string;
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  series: ChartSeries;
  yMin?: number;
  yMax?: number;
}

/** 当前文档只用于显示和本地状态重新校验，不回写 Runtime。 */
export const UiDocumentContext = createContext<UiDocument | undefined>(undefined);

/** 当前块延续动作绑定到其不可变会话、Turn 与 UI 身份。 */
export const UiContinuationContext = createContext<{ target: UiContinueTarget; action?: UiContinuation } | undefined>(undefined);

/** 当前块唯一的状态重置回调；重挂载仅影响该块的 Provider 子树。 */
export const UiResetContext = createContext<(() => void) | undefined>(undefined);
