/** 专用精排供应商协议；宿主注入适配器，RAG 只消费按相关性降序排列的统一结果。 */
export type RerankRole = "text" | "vision";

/** 单个受控候选；图片仅使用宿主已读取的 Data URI。 */
export interface RerankDocument {
  text: string;
  image?: string;
}

/** 供应商请求上下文；凭据与文档只在本次运行中使用，不得持久化。 */
export interface RerankProviderRequest {
  baseUrl: string;
  apiKey: string;
  role: RerankRole;
  model: string;
  query: string;
  documents: RerankDocument[];
}

/** 统一排序条目；index 对应输入位置，分数不跨供应商比较，相关性未知时省略 relevant。 */
export interface RerankProviderResult {
  index: number;
  score?: number;
  relevant?: boolean;
}

/** 受信供应商适配器；请求转换与分数语义归供应商，共享层负责发送、重试及全量索引校验。 */
export interface RerankProviderAdapter {
  readonly id: string;
  readonly supportedRoles: readonly RerankRole[];
  /** 构造专用精排 POST 请求，不在适配器中发送网络请求。 */
  createRequest(input: RerankProviderRequest): { url: string; headers: Record<string, string>; body: string };
  /** 转换为最相关在前的完整候选列表；仅在有对应模型策略时给出 relevant。 */
  parseResponse(payload: unknown, context: { model: string; role: RerankRole }): RerankProviderResult[];
}
