/**
 * runtime/protocol/work-preview-capability.ts — Work 内置预览的宿主能力协议
 *
 * 受信 Web Work Host 在 Trust 后经 CapabilityLoader 注入；Core 只定义请求/结果/绑定的
 * Host-neutral 契约，不实现 URL 解析、DOM 读取、进程执行或任何网络行为。
 * 目标校验、Job 归属与本地就绪均由宿主 PreviewService 承担（Talk-Plan0908 Stage2）。
 */

/** 打开时机：now=当前展示已知页面；after_turn=本轮正常终态后交付；工具输入缺省 after_turn。 */
export type WorkPreviewOpenWhen = "now" | "after_turn";

/** open_preview 的准备请求；身份字段由 Runtime 绑定，不从模型输入取得。 */
export interface WorkPreviewPrepareRequest {
  /** 模型声明的目标页面地址；规范化与目标策略校验在宿主侧执行。 */
  url: string;
  /** 可选的关联后台 Job 引用；归属校验由宿主执行，模型传入不能自行获得免确认资格。 */
  jobId?: string;
  openWhen: WorkPreviewOpenWhen;
  /** 工具身份四元组：来自 Runtime 绑定（Talk-Plan0908 §7.1），模型输入不可伪造。 */
  workspaceId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  /** 取消信号：宿主在准备与就绪阶段必须立即停止。 */
  signal?: AbortSignal;
}

/** 准备成功的安全事实；copyUrl 为宿主批准的实际页面地址，不含凭据或内部映射。 */
export interface WorkPreviewPrepareResult {
  previewId: string;
  hostLabel: string;
  copyUrl: string;
  openWhen: WorkPreviewOpenWhen;
  state: "prepared";
  /**
   * 宿主核验后绑定到该预览的后台 Job；只有声明地址、活动身份与监听归属全部成立时才存在。
   * 模型传入的 jobId 不能直接成为该字段。
   */
  jobId?: string;
  /** 自动展开资格；缺省视为允许，false 表示无法证明服务归属，只能由用户显式打开。 */
  autoOpen?: boolean;
}

/** Work 预览能力端口：只准备导航交付，绝不返回页面内容或"已验证"结论。 */
export interface WorkPreviewCapability {
  preparePreview(request: WorkPreviewPrepareRequest): Promise<WorkPreviewPrepareResult>;
}
