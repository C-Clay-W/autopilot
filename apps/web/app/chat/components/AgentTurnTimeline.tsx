/**
 * Completed Agent-turn timeline that pairs each reasoning phase with its model reply.
 */
"use client";

import MarkdownRenderer from "../../components/MarkdownRenderer";
import ChainOfThought from "./ChainOfThought";
import type { ProcessStep } from "./process-step";

export interface AgentTurnSegment {
  id: string;
  content: string;
  processSteps: ProcessStep[];
}

interface AgentTurnTimelineProps {
  segments: AgentTurnSegment[];
}

/** Render completed segments in sequence; each reasoning section stays collapsed by default. */
export default function AgentTurnTimeline({ segments }: AgentTurnTimelineProps) {
  if (!segments.length) return null;

  return (
    <div className="space-y-3">
      {segments.map((segment) => (
        <section key={segment.id}>
          {segment.processSteps.length > 0 && <ChainOfThought steps={segment.processSteps} />}
          <MarkdownRenderer content={segment.content} />
        </section>
      ))}
    </div>
  );
}
