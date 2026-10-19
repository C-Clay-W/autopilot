/** 已退休的 Work 私有知识入口；保留安全不可用响应，原始数据不变。 */
import { workKnowledgeUnavailable } from "@/lib/workspace-host/work-route-boundary";

/** 此方法不再提供私有知识访问。 */
export function GET(): Response { return workKnowledgeUnavailable(); }
