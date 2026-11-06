/**
 * node/host-identity.ts — 本机宿主身份约定
 *
 * 同一台机器上的 Web 与 CLI 代表同一个本机人类：principalId 由受信宿主注入 Core，
 * 只用于组归属与幂等域，不是认证凭据，也不能由模型、消息正文或请求参数自报。
 * 首版是单用户约定；未来多用户或远端场景必须由实际认证主体替换本值。
 */

import { createHash } from "node:crypto";

/** 本机人类身份；沿用 Web 首版持久值，保证已建协作组在 Web 与 CLI 两端都可读。 */
export const LOCAL_HUMAN_PRINCIPAL_ID = "web-local-user";

/** 状态根的不透明稳定身份：只暴露摘要，不把宿主绝对路径写入游标或事件。 */
export function createNodeStateRootId(stateRoot: string): string {
  return createHash("sha256").update(stateRoot).digest("hex");
}
