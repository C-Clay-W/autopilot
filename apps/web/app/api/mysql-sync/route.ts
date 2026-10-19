/**
 * POST /api/mysql-sync：按 databaseName 生成 MySQL 的离线 SQLite 与 LanceDB 快照，不开放任意 SQL。
 */
import { NextResponse } from "next/server";
import type * as Core from "@autopilot-agent/core";

type DatabaseCore = typeof Core & {
  createDatabaseSnapshot(input: { databaseName: string }): { sync(): Promise<unknown> };
  getDefaultDatabaseSource(): { database: string };
};

export const maxDuration = 120;

/** 动态加载 core，避免 Turbopack 静态打包原生数据库或 wasm 运行时依赖。 */
function loadCore(): DatabaseCore {
  return eval("require")("@autopilot-agent/core") as DatabaseCore;
}

/** 将底层异常收敛为安全摘要，避免密码、DSN 与完整连接串进入 API 响应。 */
function toSafeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "数据库同步失败";
  return /password|dsn|access denied/i.test(message) ? "数据库连接、权限或同步失败" : message;
}

/** 同步环境中唯一已配置的明清数据库源；浏览器不可传数据库名、连接信息或 SQL。 */
export async function POST() {
  try {
    const { createDatabaseSnapshot, getDefaultDatabaseSource } = loadCore();
    const databaseName = getDefaultDatabaseSource().database;
    const result = await createDatabaseSnapshot({ databaseName }).sync();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: toSafeError(error) }, { status: 500 });
  }
}
