/**
 * GET /api/mysql-inspect：按 databaseName 检查服务端注册的 MySQL 数据源并返回非敏感 Schema 摘要。
 */
import { NextResponse } from "next/server";
import type * as Core from "@autopilot-agent/core";

type DatabaseCore = typeof Core & {
  createDatabaseSnapshot(input: { databaseName: string }): { inspectSource(): Promise<unknown> };
};

/** 动态加载 core，避免 Turbopack 静态打包 MySQL 与 SQLite 运行时依赖。 */
function loadCore(): DatabaseCore {
  return eval("require")("@autopilot-agent/core") as DatabaseCore;
}

/** 将底层异常收敛为安全摘要，避免连接配置进入 API 响应。 */
function toSafeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "数据库检查失败";
  return /password|dsn|access denied/i.test(message) ? "数据库连接或权限检查失败" : message;
}

/** 根据 query 中唯一的 databaseName 检查数据源；不接受任何浏览器连接参数。 */
export async function GET(request: Request) {
  try {
    const databaseName = new URL(request.url).searchParams.get("databaseName")?.trim();
    if (!databaseName) return NextResponse.json({ error: "请提供 databaseName" }, { status: 400 });
    const { createDatabaseSnapshot } = loadCore();
    const result = await createDatabaseSnapshot({ databaseName }).inspectSource();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: toSafeError(error) }, { status: 500 });
  }
}
