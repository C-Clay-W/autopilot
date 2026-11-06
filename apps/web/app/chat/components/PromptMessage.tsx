/** 普通Prompt的共享边框、纸本配色与受信Thread外部来源标签。 */
import type { ReactNode } from "react";

/** 来源仅由宿主投影的origin决定，正文与追加输入共用同一气泡。 */
export default function PromptMessage({ fromThread, children }: { fromThread: boolean; children: ReactNode }) {
  return <>{fromThread && <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted">Sent by Autopilot from another thread</p>}<div data-prompt-body className="group relative break-words border-2 border-ink bg-card px-4 py-3 text-sm leading-relaxed text-ink">{children}</div></>;
}
