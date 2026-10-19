/** Talk-Plan0813 TUI R4 定向测试：退出 recap 仅包含安全会话字段且保持单行。 */

import { describe, expect, it } from "vitest";
import { formatCliTuiRecap } from "../src/tui.js";

describe("Talk-Plan0813 TUI R4", function tuiUpdateR4Suite() {
  it("已完成 recap 不再给出误导性的 resume 指引", function formatsSafeRecap() {
    const recap = formatCliTuiRecap({
      sessionId: "session-safe-123",
      completedTurnCount: 2,
      finalStatus: "completed",
      recoverable: false,
    });

    expect(recap).toBe("Autopilot recap · Session: session-safe-123 · Completed turns: 2 · Final status: Completed\n");
    expect(recap.split("\n")).toHaveLength(2);
    expect(recap).not.toContain("\u001b[");
    expect(recap).not.toMatch(/checkpoint|stateRoot|workspaceRoot/iu);
  });

  it("只有 Core 确认可恢复时才显示 resume 指引", function formatsResumableRecap() {
    expect(formatCliTuiRecap({ sessionId: "session-safe-123", completedTurnCount: 1, finalStatus: "interrupted_recoverable", recoverable: false }))
      .not.toContain("Resume:");
    expect(formatCliTuiRecap({ sessionId: "session-safe-123", completedTurnCount: 1, finalStatus: "interrupted_recoverable", recoverable: true }))
      .toContain("Resume: ap resume --session session-safe-123");
  });
});
