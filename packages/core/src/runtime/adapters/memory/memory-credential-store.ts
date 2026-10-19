/**
 * 内存 CredentialStore 适配器
 *
 * Phase 2 占位实现：拒绝所有凭据请求，用于 contract test 中不需要真实 Key 的场景。
 */

import type { CredentialRef, ResolvedCredential } from "../../domain";
import type { CredentialStore } from "../../ports";

export class MemoryCredentialStore implements CredentialStore {
  private credentials = new Map<string, ResolvedCredential>();

  set(ref: CredentialRef, credential: ResolvedCredential): void {
    this.credentials.set(`${ref.provider}:${ref.key}`, credential);
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
    const found = this.credentials.get(`${ref.provider}:${ref.key}`);
    if (!found) {
      throw new Error(`Credential not found: ${ref.provider}:${ref.key}`);
    }
    return found;
  }
}
