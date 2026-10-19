/** 将完整且无歧义的 RAG 表格摘录转换为 Markdown；不补全字段、不改写证据值。 */

/** 转义表格单元格中的 Markdown，保留原文显示并避免生成链接或图片。 */
function escapeCell(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#!|~])/g, "\\$1");
}

/** 仅转换 canonical Excel 的完整表头和记录；代码围栏、残缺或歧义行保持原文。 */
export function formatRagTables(content: string): string {
  const lines = content.split(/\r?\n/);
  type TableBlock = { headers: string[]; rows: string[][]; citation: string };
  const output: (string | TableBlock)[] = [];
  const sourceSection = content.lastIndexOf("\n\n来源：");
  const sourceNumbers = sourceSection < 0 ? [] : [...content.slice(sourceSection).matchAll(/^\[(\d+)\] .+$/gm)].map(function number(match) { return `[${match[1]}]`; });
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      output.push(line); continue;
    }
    if (fence || !line.startsWith("表头: ")) { output.push(line); continue; }
    const headers = line.slice(4).split(" | ");
    if (headers.some(function invalid(header) { return !header || /[;:\n]/.test(header); }) || new Set(headers).size !== headers.length) { output.push(line); continue; }
    const rows: string[][] = [];
    let citation = "";
    let next = index + 1;
    for (; next < lines.length; next++) {
      const record = /^记录 #(\d+): (.*?)(?: \[([A-Za-z0-9_-]+)\])?$/.exec(lines[next]);
      if (!record) break;
      const cells = record[2].split("; ");
      if (cells.length !== headers.length || cells.some(function mismatch(cell, cellIndex) { return !cell.startsWith(`${headers[cellIndex]}: `); })) break;
      rows.push([record[1], ...cells.map(function value(cell, cellIndex) { return cell.slice(headers[cellIndex].length + 2); })]);
      if (record[3]) { citation = `[${record[3]}]`; next++; break; }
    }
    // 若下一行仍是记录，则本块解析不完整，保留原始摘录以免悄悄截断。
    if (!rows.length || /^记录 #/.test(lines[next] ?? "")) { output.push(line); continue; }
    let previous = output.length - 1;
    while (previous >= 0 && typeof output[previous] === "string" && !(output[previous] as string).trim()) previous--;
    const table = output[previous];
    // 仅合并相邻且来源、表头一致的完整片段，保留原记录顺序与全部数值。
    if (table && typeof table !== "string" && citation && table.citation === citation && JSON.stringify(table.headers) === JSON.stringify(headers)) {
      table.rows.push(...rows); output.splice(previous + 1);
    } else output.push({ headers, rows, citation });
    index = next - 1;
  }
  return output.map(function render(block) {
    if (typeof block === "string") return block;
    const { headers, rows, citation } = block;
    const label = citation && !(sourceNumbers.length === 1 && sourceNumbers[0] === citation) ? `资料摘录（来源 ${citation}）\n\n` : "";
    return `\n${label}| ${["记录", ...headers].map(escapeCell).join(" | ")} |\n| ${headers.map(function divider() { return "---"; }).concat("---").join(" | ")} |\n` + rows.map(function row(cells) { return `| ${cells.map(escapeCell).join(" | ")} |`; }).join("\n") + "\n";
  }).join("\n");
}
