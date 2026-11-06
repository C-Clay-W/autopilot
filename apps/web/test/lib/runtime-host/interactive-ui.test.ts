/** S2 Host 投影夹具：同一安全事件的 SSE/History 与普通文字回退。 */
import { describe, expect, it } from "vitest";
import { createUiEnvelopes } from "../../../../../packages/presentation/test/interactive-ui.fixture";
import { createPresentationState, selectUiDocuments } from "@autopilot-agent/presentation";
import { toWebAgentEventDto } from "@/lib/runtime-host/web-ui-dto";
import { reduceWebPresentationEvent, replayWebPresentation } from "@/lib/runtime-host/web-presentation-adapter";
import { projectEvents } from "@/lib/runtime-host/web-message-projection";

describe("S2 interactive UI host projection", function suite() {
  it("SSE展平与History通过同一reducer，保留顺序、归属及安全文档", function replay() {
    const events = createUiEnvelopes();
    const live = events.reduce(function reduce(state, envelope) { return reduceWebPresentationEvent(state, { sessionId: envelope.sessionId, timestamp: envelope.timestamp, ...toWebAgentEventDto(envelope) }, envelope.sessionId); }, createPresentationState());
    const history = replayWebPresentation(events);
    expect(live).toEqual(history);
    expect(selectUiDocuments(live, "turn-ui")[0]).toMatchObject({ sessionId: "session-ui", turnId: "turn-ui", document: { schemaVersion: 1 } });
    const projection = projectEvents(events.slice(0, 4));
    expect(projection.answer).toContain("前文");
    expect(projection.answer).toContain("期末余额3400元");
    expect(projection.answer).toContain("后文");
    expect(projection.answer).not.toContain("$computed");
  });
});
