/**
 * Excel 解析 — 按行入库
 * - 使用 SheetJS (xlsx) 解析 .xlsx / .xls 文件
 * - 默认读取第一个工作表，将每一行转为 Record<string, unknown>
 * - 支持指定工作表名称、表头行索引、数据起始行
 */
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import { ParseExcelOptions } from "../types";


/**
 * 将 Excel 文件按行解析为结构化数据
 *
 * 原理：
 * 1. 读取 Excel 二进制文件
 * 2. 使用 SheetJS 解析为二维数组（sheet_to_json）
 * 3. 以 headerRow 行作为列名（表头）
 * 4. 从 dataStartRow 开始逐行读取数据，组装为 Record<string, unknown>
 *
 * @param filePath Excel 文件路径
 * @param options  解析选项
 * @returns 行数据数组，每行为一个键值对对象
 * @throws 当文件不存在、格式不支持、工作表不存在时抛出异常
 */
export async function parseExcel(
  filePath: string,
  options: ParseExcelOptions = {}
): Promise<Record<string, unknown>[]> {
  const {
    sheetName,
    headerRow = 0,
    dataStartRow,
    skipEmptyRows = true,
  } = options;

  // 校验文件存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel 文件不存在: ${filePath}`);
  }

  // 读取并解析 Excel 文件
  const workbook = XLSX.readFile(filePath);

  // 确定工作表
  const targetSheetName = sheetName ?? workbook.SheetNames[0];
  if (!targetSheetName) {
    throw new Error(`Excel 文件中没有找到工作表`);
  }

  const sheet = workbook.Sheets[targetSheetName];
  if (!sheet) {
    throw new Error(
      `工作表 "${targetSheetName}" 不存在，可用的工作表: ${workbook.SheetNames.join(", ")}`
    );
  }

  // 将工作表转为二维数组（header: 1 表示返回纯数组，不以第一行为键）
  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  if (rawData.length === 0) {
    return [];
  }

  // 提取表头行
  const headers = rawData[headerRow] ?? [];
  if (headers.length === 0) {
    throw new Error(`表头行（第 ${headerRow + 1} 行）为空`);
  }

  // 确定数据起始行
  const startRow = dataStartRow ?? headerRow + 1;

  // 逐行组装数据
  const rows: Record<string, unknown>[] = [];

  for (let i = startRow; i < rawData.length; i++) {
    const rowData = rawData[i];
    if (!rowData || rowData.length === 0) {
      if (skipEmptyRows) continue;
      rows.push({});
      continue;
    }

    // 检查是否为全空行
    const hasValue = rowData.some(
      (cell) => cell !== null && cell !== undefined && cell !== ""
    );
    if (!hasValue && skipEmptyRows) continue;

    const record: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = String(headers[j] ?? `column_${j}`);
      record[header] = rowData[j] ?? null;
    }

    rows.push(record);
  }

  return rows;
}

/**
 * 列出 Excel 文件中所有工作表名称
 *
 * @param filePath Excel 文件路径
 * @returns 工作表名称数组
 */
export function listSheetNames(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel 文件不存在: ${filePath}`);
  }
  const workbook = XLSX.readFile(filePath);
  return workbook.SheetNames;
}

/**
 * 获取 Excel 工作表概览（行数、列数、表头）
 *
 * @param filePath  Excel 文件路径
 * @param sheetName 工作表名称（不传则取第一个）
 * @returns 概览信息
 */
export function getSheetInfo(
  filePath: string,
  sheetName?: string
): { sheetName: string; rowCount: number; colCount: number; headers: string[] } {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel 文件不存在: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath);
  const targetName = sheetName ?? workbook.SheetNames[0];
  if (!targetName) {
    throw new Error(`Excel 文件中没有找到工作表`);
  }

  const sheet = workbook.Sheets[targetName];
  if (!sheet) {
    throw new Error(`工作表 "${targetName}" 不存在`);
  }

  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  const headers = (rawData[0] ?? []).map((h) => String(h ?? ""));
  const colCount = headers.length;
  const rowCount = Math.max(0, rawData.length - 1); // 减去表头行

  return { sheetName: targetName, rowCount, colCount, headers };
}
