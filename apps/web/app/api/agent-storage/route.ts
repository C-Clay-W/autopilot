/**
 * GET/PUT /api/agent-storage：返回或更新本机服务端全局 Agent 存储配额，不执行 Agent、RAG 或工具。
 */
import { NextResponse } from "next/server";
import { reconcileAgentStorage, setAgentStorageHardLimit } from "@/lib/agent-storage/quota-manager";

/** 返回 UI 展示所需的实时存储用量、水位和可配置范围。 */
export function GET() {
  try {
    return NextResponse.json(reconcileAgentStorage());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** 保存用户提交的本机服务端全局硬上限，并返回保存后实时用量状态。 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { hardLimit?: unknown };
    if (typeof body.hardLimit !== "number" || !Number.isSafeInteger(body.hardLimit)) return NextResponse.json({ error: "hardLimit 必须是整数字节数" }, { status: 400 });
    return NextResponse.json(setAgentStorageHardLimit(body.hardLimit));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
