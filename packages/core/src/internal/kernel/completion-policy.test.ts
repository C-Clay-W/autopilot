/** 完成策略回归：精确报告遗漏文件，有限提醒耗尽后只暂停，不伪造完成。 */
import { expect, it } from "vitest";
import { createMutationCompletionPolicy } from "./completion-policy";

it("只列遗漏路径并在补救耗尽时保留待验证暂停", function listsMissingPaths() {
  const policy = createMutationCompletionPolicy();
  const state = { required: true, strong: false, changedPaths: new Set(["verified.ts", "missing-b.ts", "missing-a.ts"]), verifiedPaths: new Set(["verified.ts"]), recoveryAttempts: 0 };
  const retry = policy.evaluate({ state });
  expect(retry.action).toBe("retry");
  if (retry.action !== "retry") throw new Error("retry missing");
  expect(retry.message).toContain('"missing-a.ts"\n"missing-b.ts"');
  expect(retry.message).not.toContain('"verified.ts"');
  expect(policy.evaluate({ state: { ...state, recoveryAttempts: 1 } }).action).toBe("pause");
  expect(policy.evaluate({ state: { ...state, verifiedPaths: state.changedPaths, recoveryAttempts: 1 } })).toEqual({ action: "accept" });
});
