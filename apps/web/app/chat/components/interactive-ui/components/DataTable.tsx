/** Intelligent UI 的纸本数据表，筛选和排序只保存在本组件实例。 */
"use client";

import { useId, useState, type ChangeEvent } from "react";
import type { InteractiveUiProps } from "../context";
import { controlClass } from "./inputs";

type TableColumn = { key: string; label: string; align?: string };
type TableRow = Record<string, string | number>;
type SortState = { key: string; direction: "asc" | "desc" } | undefined;

/** 检查列值是否都存在且保持一种可排序的字符串或数值类型。 */
function readSortableType(rows: TableRow[], key: string): "string" | "number" | undefined {
  if (!rows.length) return undefined;
  const firstType = typeof rows[0][key];
  if (firstType !== "string" && firstType !== "number") return undefined;
  return rows.every(function sameType(row) { return typeof row[key] === firstType; }) ? firstType : undefined;
}

/** 表格保留有序原行副本；筛选严格相等，排序不修改文档数据。 */
function DataTable({ element }: InteractiveUiProps) {
  const { columns, rows, caption, filterColumnKey, sortable } = element.props as { columns: TableColumn[]; rows: TableRow[]; caption?: string; filterColumnKey?: string; sortable?: boolean };
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<SortState>(undefined);
  const filterId = useId();
  const filterColumn = filterColumnKey ? columns.find(function find(column) { return column.key === filterColumnKey; }) : undefined;
  const filterValues = filterColumnKey ? Array.from(new Set(rows.map(function value(row) { return row[filterColumnKey]; }))) : [];
  const selectedFilter = filter === "all" ? undefined : filterValues[Number(filter)];
  const visibleRows = rows.map(function entry(row, index) { return { row, index }; }).filter(function matches(entry) {
    return !filterColumnKey || filter === "all" || entry.row[filterColumnKey] === selectedFilter;
  });

  if (sort) {
    const type = readSortableType(rows, sort.key);
    if (type) {
      const direction = sort.direction === "asc" ? 1 : -1;
      visibleRows.sort(function compare(left, right) {
        const leftValue = left.row[sort.key];
        const rightValue = right.row[sort.key];
        const compared = type === "number" ? Number(leftValue) - Number(rightValue) : String(leftValue).localeCompare(String(rightValue), "zh-CN");
        return compared === 0 ? left.index - right.index : compared * direction;
      });
    }
  }

  /** 在同一列的升序、降序、原始顺序之间循环。 */
  function changeSort(key: string) {
    if (!sortable || !readSortableType(rows, key)) return;
    setSort(function nextSort(current) {
      if (current?.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return undefined;
    });
  }

  /** 筛选值以列项索引编码，避免与实际字符串值冲突。 */
  function changeFilter(event: ChangeEvent<HTMLSelectElement>) {
    setFilter(event.currentTarget.value);
  }

  return <div className="min-w-0 max-w-full space-y-2">{filterColumn && <div className="max-w-sm"><label htmlFor={filterId} className="mb-1 block text-xs font-semibold">按{filterColumn.label}筛选</label><select id={filterId} value={filter} onChange={changeFilter} className={controlClass}><option value="all">全部</option>{filterValues.map(function option(value, index) { return <option key={index} value={index}>{String(value)}</option>; })}</select></div>}<div className="max-w-full overflow-x-auto border-2 border-ink bg-card"><table className="w-full border-collapse text-xs">{caption && <caption className="px-2 py-2 text-left text-muted">{caption}</caption>}<thead><tr className="bg-ink">{columns.map(function heading(column) {
    const type = readSortableType(rows, column.key);
    const canSort = sortable === true && type !== undefined;
    const ariaSort = sort?.key === column.key ? sort.direction === "asc" ? "ascending" : "descending" : canSort ? "none" : undefined;
    const sortLabel = sort?.key === column.key ? sort.direction === "asc" ? "升序" : "降序" : "排序";
    return <th key={column.key} scope="col" aria-sort={ariaSort} className={`border-b-2 border-ink px-2 py-2 text-ink-on-dark ${column.align === "right" ? "text-right" : "text-left"}`}>{canSort ? <button type="button" onClick={function sortColumn() { changeSort(column.key); }} aria-label={`按${column.label}排序，当前${sortLabel}`} className="font-semibold focus-visible:outline-2 focus-visible:outline-accent">{column.label}<span className="ml-1 text-xs">{sort?.key === column.key ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</span></button> : column.label}</th>;
  })}</tr></thead><tbody>{visibleRows.length ? visibleRows.map(function row(entry) { return <tr key={entry.index} className="border-b border-ink/20 hover:bg-ink/10">{columns.map(function cell(column) { return <td key={column.key} className={`break-words px-2 py-2 text-ink ${column.align === "right" ? "text-right tabular-nums" : "text-left"}`}>{entry.row[column.key]}</td>; })}</tr>; }) : <tr><td colSpan={columns.length} className="px-3 py-4 text-center text-sm text-muted">没有符合条件的结果。</td></tr>}</tbody></table></div></div>;
}

export default DataTable;
