/**
 * Node WorkspaceTrustPolicy 的 denied/expired 重新确认契约。
 *
 * 冻结：拒绝记录只有在显式 grantTrust 后才覆盖为 trusted；过期记录读取为 expired，
 * 重新授权后才回到 trusted；读取本身绝不静默改写任何记录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeTrustPolicy } from "../src/index";

const temporaryRoots: string[] = [];

/** 创建测试独占的临时目录。 */
function createTemporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rag-next-trust-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(function cleanTemporaryRoots() {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Node WorkspaceTrustPolicy contracts", function nodeTrustPolicyContracts() {
  it("grantTrust 持久化精确 canonical 工作区，重复读取稳定返回 trusted", async function grantsExactCanonicalWorkspace() {
    const stateRoot = createTemporaryRoot("state");
    const workspaceRoot = createTemporaryRoot("workspace");
    const policy = createNodeTrustPolicy({ stateRoot });

    const granted = await policy.grantTrust(workspaceRoot);
    expect(granted.status).toBe("trusted");
    expect(granted.workspaceRoot).toBe(fs.realpathSync.native(workspaceRoot));
    expect((await policy.getTrustStatus(workspaceRoot)).status).toBe("trusted");
  });

  it("denyTrust 持久化 denied，读取不静默改写", async function deniesAndKeepsDenied() {
    const stateRoot = createTemporaryRoot("deny-state");
    const workspaceRoot = createTemporaryRoot("deny-workspace");
    const policy = createNodeTrustPolicy({ stateRoot });

    await policy.denyTrust(workspaceRoot, "用户拒绝");
    expect((await policy.getTrustStatus(workspaceRoot)).status).toBe("denied");
    expect((await policy.getTrustStatus(workspaceRoot)).status).toBe("denied");
  });

  it("denied 记录只有显式 grantTrust 才覆盖为 trusted", async function reGrantAfterDeny() {
    const stateRoot = createTemporaryRoot("regrant-state");
    const workspaceRoot = createTemporaryRoot("regrant-workspace");
    const policy = createNodeTrustPolicy({ stateRoot });

    await policy.denyTrust(workspaceRoot, "用户拒绝");
    await policy.grantTrust(workspaceRoot);
    expect((await policy.getTrustStatus(workspaceRoot)).status).toBe("trusted");
  });

  it("过期的 trusted 记录读取为 expired，显式 grant 后重新 trusted", async function expiresAndRegrants() {
    const stateRoot = createTemporaryRoot("expire-state");
    const workspaceRoot = createTemporaryRoot("expire-workspace");
    let now = 1_000;
    const policy = createNodeTrustPolicy({ stateRoot, now: function readClock() { return now; } });

    await policy.grantTrust(workspaceRoot, { expiresAt: 2_000 });
    now = 2_001;
    expect((await policy.getTrustStatus(workspaceRoot)).status).toBe("expired");

    await policy.grantTrust(workspaceRoot);
    expect((await policy.getTrustStatus(workspaceRoot)).status).toBe("trusted");
  });
});
