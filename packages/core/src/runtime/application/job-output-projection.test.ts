/** Job 安全输出投影测试：覆盖 UTF-8、脱敏、窗口缺口和 cursor 代次。 */

import { describe, expect, it } from "vitest";
import { JobOutputProjector } from "./job-output-projection";

describe("JobOutputProjector", function suite() {
  it("CR 丢弃超长敏感记录的全部后续分片并隔离双流 cursor", function rejectsPartialSecretAndCrossStreamCursor() {
    const projector = new JobOutputProjector();
    projector.append("stdout", Buffer.from(`API_KEY=${"x".repeat(9000)}`));
    projector.append("stdout", Buffer.from("secret-tail\n正常\n"));
    projector.append("stderr", Buffer.from("error-line\n"));
    projector.flush();
    const output = projector.read();
    expect(output.stdout.text).not.toContain("secret-tail");
    expect(output.stdout.text).toContain("正常");
    expect(projector.read({ stderrCursor: output.stdout.nextCursor }).stderr.resetRequired).toBe(true);
  });
  it("跨字节分片解码中文和 emoji，并清理控制序列与敏感字段", function sanitizesChunks() {
    const projector = new JobOutputProjector({ sensitiveValues: ["known-secret"] });
    const bytes = Buffer.from("中文😀 API_TOKEN=secret known-secret \u001b[31mred\u001b[0m C:\\private\\file.txt\n", "utf8");
    for (const byte of bytes) projector.append("stdout", Buffer.from([byte]));
    projector.flush();
    const output = projector.read().stdout;
    expect(output.text).toContain("中文😀");
    expect(output.text).toContain("API_TOKEN=[REDACTED]");
    expect(output.text).toContain("[ABSOLUTE_PATH]");
    expect(output.text).not.toContain("secret");
    expect(output.text).not.toContain("\u001b");
    expect(output.text).not.toContain("�");
  });

  it("安全窗口淘汰返回 gap，错误代次要求 reset", function reportsGapAndReset() {
    const projector = new JobOutputProjector();
    projector.append("stdout", Buffer.from(`${"行😀\n".repeat(12_000)}`, "utf8"));
    projector.flush();
    const first = projector.read().stdout;
    expect(first.truncated).toBe(true);
    expect(first.gap).toBe(true);
    const current = projector.read({ stdoutCursor: first.nextCursor }).stdout;
    expect(current.text).toBe("");
    const invalid = projector.read({ stdoutCursor: "invalid-cursor" }).stdout;
    expect(invalid.resetRequired).toBe(true);
    expect(invalid.text).toBe(first.text);
    expect(invalid.text).not.toContain("�");
  });

  it("过长未完成敏感片段只发布省略标记", function omitsOversizedCarry() {
    const projector = new JobOutputProjector();
    projector.append("stderr", Buffer.from(`API_KEY=${"x".repeat(9_000)}`, "utf8"));
    projector.flush();
    const output = projector.read().stderr.text;
    expect(output).toContain("过长未完成输出已省略");
    expect(output).not.toContain("API_KEY=");
  });
});
