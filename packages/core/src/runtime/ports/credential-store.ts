/**
 * CredentialStore Port — 凭据解析接口
 *
 * Core 只保存 CredentialRef，真实 Key 由该端口在运行时解析。
 */

import type { CredentialRef, ResolvedCredential } from "../domain";

/** 凭据存储端口。 */
export interface CredentialStore {
  /** 将凭据引用解析为短生命周期凭据。 */
  resolve(ref: CredentialRef): Promise<ResolvedCredential>;
}
