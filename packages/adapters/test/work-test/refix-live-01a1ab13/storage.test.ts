/** 注入本机文件阶段失败，核对安全诊断与原会话保留，不推断实机errno。 */
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { initializeNodeStateRoot } from "../../../src/node/state-root";
import { createNodeSessionStore } from "../../../src/node/stores/node-session-store";
import { NodeStateError } from "../../../src/node/node-errors";
import { atomicReplace, getFileOperationDiagnostic } from "../../../src/node/file-utils";
/** 每项使用独立已初始化根，不触碰用户记录。 */
function fixture() { const base = path.resolve("../../.agent-tests/work-test/refix-live-01a1ab13/fixtures"); fs.mkdirSync(base, {recursive:true}); const root = fs.mkdtempSync(path.join(base,"storage-")); initializeNodeStateRoot(root); return root; }
it.each(["temporary_write", "rename", "lock"] as const)("保存阶段 %s 安全诊断且原字节保留", async function failure(phase) {
  const root = fixture(); const store = createNodeSessionStore({stateRoot:root});
  const session = { id:"session", productMode:"work", projectId:"p", status:"idle", createdAt:1, updatedAt:1 } as any;
  await store.save(session); const file = path.join(root,"sessions/session.json"); const before = fs.readFileSync(file);
  const method = phase === "rename" ? "renameSync" : phase === "lock" ? "openSync" : "writeFileSync";
  const original = fs[method];
  const spy = vi.spyOn(fs, method).mockImplementation(function fail(...args: any[]) {
    const target = String(args[0]);
    if (phase === "rename" || phase === "lock" && target.endsWith(".lock") || phase === "temporary_write" && target.endsWith(".tmp")) throw Object.assign(new Error("SECRET path body"), {code:"EIO"});
    return (original as any)(...args);
  } as any);
  let error: any;
  try { await store.save({...session,title:"new"}); } catch(e) { error=e; } finally {spy.mockRestore();}
  expect(error).toBeInstanceOf(NodeStateError); expect(error.code).toBe("STATE_STORAGE_UNAVAILABLE");
  expect(error.getStorageDiagnostic()).toMatchObject({operation:"session_save",target:"session",phase,osCode:"EIO"});
  expect(JSON.stringify(error)).not.toMatch(/SECRET|EIO|session_save/); expect(fs.readFileSync(file)).toEqual(before);
  expect((await store.get("session"))?.id).toBe("session");
});
it("rename失败后cleanup失败保留首因，独立cleanup失败可识别", function cleanup() {
  const root=fixture(); const file=path.join(root,"target"); fs.writeFileSync(file,"old");
  const rename=vi.spyOn(fs,"renameSync").mockImplementation(function fail(){throw Object.assign(new Error("private"),{code:"EBUSY"});});
  const unlink=vi.spyOn(fs,"unlinkSync").mockImplementation(function fail(){throw Object.assign(new Error("private"),{code:"EPERM"});});
  try { atomicReplace(file,"new"); throw new Error("expected failure"); } catch(error) { expect(getFileOperationDiagnostic(error)).toMatchObject({phase:"rename",osCode:"EBUSY",cleanupFailed:true}); }
  finally {rename.mockRestore();unlink.mockRestore();}
  expect(fs.readFileSync(file,"utf8")).toBe("old");
});
