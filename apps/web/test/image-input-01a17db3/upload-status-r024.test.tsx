/** 验证 Work 图片上传状态和 Chat 上传分支的展示边界。 */
import { createRef, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatMessageList from "@/app/chat/components/ChatMessageList";

/** 构造仅包含上传状态的消息列表。 */
function renderUpload(isChat: boolean, currentRetrieval: "rag" | "none"): string {
  const props = {
    isChat, currentRetrieval, messages: [], sessionId: "s", loading: true, submissionActivity: "upload",
    knowledgeProgress: [], pinnedSkills: [], presentation: { items: [], transport: "connected" },
    containerRef: createRef(), contentRef: createRef(), isPinned: true, unreadCount: 0,
  } as unknown as ComponentProps<typeof ChatMessageList>;
  return renderToStaticMarkup(<ChatMessageList {...props} />);
}
describe("图片上传状态", function suite() {
  it("Work 显示紧凑不定进度，Chat 临时附件与 RAG 保持原分支", function branches() {
    const work = renderUpload(false, "none");
    expect(work).toContain("正在上传并处理图片");
    expect(work).toContain('role="progressbar"');
    expect(work).toContain("w-64 max-w-full");
    expect(work).toContain("motion-reduce:animate-none");
    expect(work).not.toContain("aria-valuenow");
    const chat = renderUpload(true, "none");
    expect(chat).toContain("正在上传临时附件，上传完成后开始问答");
    expect(chat).not.toContain("图片上传处理中");
    const rag = renderUpload(true, "rag");
    expect(rag).toContain("正在准备上传文件");
    expect(rag).not.toContain("图片上传处理中");
  });
});
