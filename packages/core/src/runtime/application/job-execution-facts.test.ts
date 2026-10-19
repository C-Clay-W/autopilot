/** Job 执行诊断回归：区分 runner 启动拒绝、普通目标输出与信号退出，不启动进程。 */
import { describe, expect, it } from "vitest";
import { projectJobCloseFacts } from "./job-execution-facts";

describe("Job close 安全诊断", function suite() {
  it("提取目标启动拒绝阶段与 Win32 码，不暴露路径或原始 stderr", function targetSpawnFailure() {
    const facts = projectJobCloseFacts('srt-win: error: CreateProcessAsUserW(C:\\Program Files\\nodejs\\node.exe): 拒绝访问。 (0x80070005)\nsecret=private');
    expect(facts).toEqual({ phase: "target_spawn_error_reported", targetState: "unknown", win32Code: "0x80070005" });
    expect(JSON.stringify(facts)).not.toContain("node.exe");
  });
  it("普通 tsc 失败或无输出不推断目标 ready，保留真实信号", function wrapperExit() {
    expect(projectJobCloseFacts("error TS2307: missing module")).toEqual({ phase: "wrapper_exit", targetState: "unknown" });
    expect(projectJobCloseFacts("", "SIGTERM")).toEqual({ phase: "wrapper_exit", targetState: "unknown", signal: "SIGTERM" });
  });
});
