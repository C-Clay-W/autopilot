/** 白名单 json-render registry：只绘制纸本组件，不执行模型 DOM 属性或远程动作。 */
"use client";

import { schema, type ComponentRegistry } from "@json-render/react";
import type { ComponentType } from "react";
import { UI_COMPONENT_NAMES, UI_COMPONENT_SCHEMAS, type UiComponentName } from "@autopilot-agent/core/ui";
import Button from "./components/Button";
import Chart from "./components/charts";
import { Disclosure, ItemList, Metric, Steps, Tabs, Text, Timeline, UiNodeFallback } from "./components/content";
import DataTable from "./components/DataTable";
import Flowchart from "./components/Flowchart";
import { Grid, Card, Stack } from "./components/layout-components";
import { ChoiceGroup, NumericInput, Select } from "./components/inputs";
import type { InteractiveUiProps } from "./context";

/** 从 Core 的唯一 schema 构造引擎目录；文档语义仍由 Core 校验。 */
function createCatalogComponents() {
  return Object.fromEntries(UI_COMPONENT_NAMES.map(function entry(name) {
    const slots = name === "Tabs" ? ["items"] : name === "Disclosure" ? ["content"] : ["Stack", "Grid", "Card"].includes(name) ? ["default"] : [];
    return [name, { props: UI_COMPONENT_SCHEMAS[name], slots, description: name }];
  }));
}

export const uiCatalog = schema.createCatalog({ components: createCatalogComponents(), actions: {} });

/** 唯一展示注册表，完整覆盖 Core 的白名单组件目录。 */
export const uiRegistry: ComponentRegistry = Object.freeze({
  Stack,
  Grid,
  Card,
  Text,
  Metric,
  Tabs,
  Disclosure,
  NumberInput: NumericInput,
  Slider: NumericInput,
  Select,
  ChoiceGroup,
  DataTable,
  Flowchart,
  LineChart: Chart,
  BarChart: Chart,
  Button,
  ItemList,
  Timeline,
  Steps,
} satisfies Record<UiComponentName, ComponentType<InteractiveUiProps>>);

// 保留既有模块出口，旧调用方可逐步迁移到拆分后的实现文件。
export { UiContinuationContext, UiDocumentContext, UiResetContext } from "./context";
export type { ChartProps, ChartSeries } from "./context";
export { UiNodeFallback } from "./components/content";
