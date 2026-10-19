/**
 * LanceDB CLI 入口 — esbuild 打包为 dist/lancedb-cli.js，无需源码即可运行。
 * 仅供 lancedb-query.cjs 子进程调用。
 * DB 路径基于脚本自身位置解析，不受 CWD 影响。
 */
import { initVectorStore } from "./internal/lib/vector-store";
import path from "path";

export async function getLanceDBInfo(tableName?: string) {
  // 优先读环境变量，默认项目根 /lancedb/
  const envPath = process.env.LANCE_DB_PATH;
  const dbPath = envPath ? path.resolve(envPath) : path.resolve(__dirname, "../../../lancedb");
  const db = await initVectorStore(dbPath);
  const result: Record<string, unknown> = {};

  if (tableName) {
    const table = await db.openTable(tableName);
    const totalRows: number = await table.countRows();
    const rawData = await table.query().limit(50).toArray();
    const data = Array.isArray(rawData) ? rawData : [];
    const allNames: string[] = await db.tableNames();

    result.tables = allNames;
    result.currentTable = tableName;
    result.total = totalRows;
    result.returned = data.length;
    result.rows = data.map((r: any) => {
      if (!r || typeof r !== "object") return {};
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("_")) continue;
        if (k === "vector" && (Array.isArray(v) || (v as any)?.byteLength > 0))
          cleaned[k] = `[${Array.isArray(v) ? v.length : (v as any)?.length || "?"}维向量]`;
        else if (k === "metadata" && typeof v === "string")
          try { cleaned[k] = JSON.parse(v); } catch { cleaned[k] = v; }
        else cleaned[k] = v;
      }
      return cleaned;
    });
  } else {
    const names: string[] = await db.tableNames();
    result.tables = await Promise.all(names.map(async (n) => {
      try {
        const t = await db.openTable(n);
        const c: number = await t.countRows();
        const s = await t.schema();
        return { name: n, totalRows: c, columns: (s.fields || []).map((f: any) => ({ name: f.name, type: String(f.type || "unknown") })) };
      } catch { return { name: n, totalRows: -1, columns: [] }; }
    }));
  }
  return result;
}
