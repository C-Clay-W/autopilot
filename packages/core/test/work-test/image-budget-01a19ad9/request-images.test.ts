/** 全请求图片预算在采样前阻止跨消息累积，保留用户输入及恢复检查点。 */
import { describe, expect, it, vi } from "vitest";
import { createAgentKernel } from "../../../src/internal/kernel/agent-kernel";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";
import { prepareSessionImages, SessionImageError } from "../../../src/internal/kernel/session-images";
import { normalizeAgentMessages, type AgentMessage, type AgentImageReference } from "../../../src/internal/types/agent-message";
import { estimateMessageTokens, projectMessagesForSummary } from "../../../src/internal/kernel/compact";

/** 收集受控 Kernel 事件，不访问真实 Provider。 */
async function collect(stream: AsyncIterable<any>) { const events = []; for await (const event of stream) events.push(event); return events; }

/** 构造只在本测试内持有的图片与受信读取端口。 */
function images(count: number, size = 3 * 1024 * 1024) {
  const bytes = Buffer.alloc(size);
  const refs: AgentImageReference[] = Array.from({ length: count }, function reference(_, index) { return { type: "image-ref", id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, sha256: "a".repeat(64), width: 4, height: 4 }; });
  const store = { read: vi.fn(async function read({ id }: { id: string }) { return { bytes, image: { ...refs.find(function matches(image) { return image.id === id; })!, name: "a.png", mimeType: "image/png", relativePath: "safe.png", bytes: bytes.length, gifFirstFrame: false } }; }), put: vi.fn() };
  return { refs, store };
}

/** 生成配对的工具历史，图片只属于对应工具结果。 */
function toolHistory(refs: AgentImageReference[]): AgentMessage[] {
  return [{ role: "user", content: [{ type: "text", text: "查看页面" }] }, ...refs.flatMap(function pair(image, index): AgentMessage[] { const id = `tool-${index}`; return [{ role: "assistant", content: [{ type: "tool-call", id, name: "screenshot", input: {} }] }, { role: "user", content: [{ type: "tool-result", toolCallId: id, content: [{ type: "text", text: "截图" }], isError: false, images: [image] }] }]; })];
}

describe("请求图片预算", function suite() {
  it("跨消息的用户图片编码总量超限时不采样且不丢弃输入", async function userBudget() {
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    const references = Array.from({ length: 8 }, function image(_, index) { return { type: "image-ref" as const, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, sha256: "a".repeat(64), width: 4, height: 4 }; });
    const messages = references.map(function message(image) { return { role: "user" as const, content: [image] }; });
    const sample = vi.fn().mockResolvedValue({ content: "完成", toolCalls: [], reasoningSummary: "" });
    const store = { read: vi.fn(async function read({ id }: { id: string }) { return { bytes, image: { ...references.find(function matches(image) { return image.id === id; })!, name: "a.png", mimeType: "image/png", relativePath: "safe.png", bytes: bytes.length, gifFirstFrame: false } }; }), put: vi.fn() };
    const kernel = createAgentKernel({ turnId: "budget-test", sessionId: "test-session", messages, toolRegistry: new ToolRegistry(), permissionContext: { mode: "auto_approve" }, modelSampler: { sample }, supportsImageInput: true, sessionImageStore: store });
    const events = await collect(kernel.run());
    expect(sample).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", errorCode: "IMAGE_REQUEST_BUDGET_EXCEEDED" });
    expect(events.at(-1).checkpoint.messages).toEqual(messages);
  });

  it("请求恰好28MiB编码可发送，重复引用仍按实际wire出现次数计费", async function requestBoundary() {
    const { refs, store } = images(7);
    const messages: AgentMessage[] = refs.map(function message(image) { return { role: "user", content: [image] }; });
    const prepared = await prepareSessionImages(messages, store, "s", false, new Set());
    expect(Object.values(prepared.imageData).reduce(function sum(total, image) { return total + image.data.length; }, 0)).toBe(28 * 1024 * 1024);
    expect(prepared.messages).toEqual(messages);
    store.read.mockClear();
    const duplicates: AgentMessage[] = Array.from({ length: 8 }, function message() { return { role: "user", content: [refs[0]] }; });
    await expect(prepareSessionImages(duplicates, store, "s", false, new Set())).rejects.toThrow("图片总量");
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it("工具图片按新图优先控制6MiB，旧图省略有说明且不改原历史", async function toolBudget() {
    const { refs, store } = images(5);
    const messages = toolHistory(refs);
    messages[0].content.push(refs[0]);
    const original = JSON.stringify(messages);
    const prepared = await prepareSessionImages(messages, store, "s", false, new Set());
    expect(prepared.imageData[refs[4].id].data.length).toBe(4 * 1024 * 1024);
    expect(Object.keys(prepared.imageData)).toEqual([refs[0].id, refs[4].id]);
    expect(prepared.messages[0]).toEqual(messages[0]);
    expect(JSON.stringify(prepared.messages)).toContain("older tool image omitted");
    expect(JSON.stringify(messages)).toBe(original);
    expect(store.read.mock.calls.map(function id(call) { return call[0].id; })).toEqual([refs[0].id, refs[4].id, refs[3].id]);
    expect(normalizeAgentMessages(prepared.messages)).toEqual(prepared.messages);
  });

  it("用户图占满请求预算时工具图被明确省略，用户图不被静默删除", async function userPriority() {
    const { refs, store } = images(8);
    const messages: AgentMessage[] = refs.slice(0, 7).map(function message(image) { return { role: "user", content: [image] }; });
    messages.push(...toolHistory([refs[7]]));
    const prepared = await prepareSessionImages(messages, store, "s", false, new Set());
    expect(Object.keys(prepared.imageData)).toHaveLength(7);
    expect(prepared.imageData[refs[7].id]).toBeUndefined();
    expect(JSON.stringify(prepared.messages)).toContain("older tool image omitted");
    expect(prepared.messages.slice(0, 7)).toEqual(messages.slice(0, 7));
    expect(store.read).toHaveBeenCalledTimes(7);
  });

  it("工具子预算恰好6MiB时两图都保留", async function toolBoundary() {
    const { refs, store } = images(2, 2_359_296);
    const prepared = await prepareSessionImages(toolHistory(refs), store, "s", false, new Set());
    expect(Object.values(prepared.imageData).reduce(function sum(total, image) { return total + image.data.length; }, 0)).toBe(6 * 1024 * 1024);
    expect(JSON.stringify(prepared.messages)).not.toContain("omitted");
  });

  it("视觉回退只读取下一个未完成图片，已完成历史不重读不发送编码", async function fallbackReads() {
    const { refs, store } = images(3, 3);
    const messages = toolHistory(refs);
    const prepared = await prepareSessionImages(messages, store, "s", true, new Set([refs[0].id, refs[1].id]));
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(prepared.pendingImage?.reference.id).toBe(refs[2].id);
    expect(prepared.imageData).toEqual({});
    expect(normalizeAgentMessages(prepared.messages)).toEqual(prepared.messages);
    store.read.mockClear();
    await prepareSessionImages(messages, store, "s", true, new Set(refs.map(function id(image) { return image.id; })));
    expect(store.read).not.toHaveBeenCalled();
  });

  it("checkpoint引用恢复仍复核身份，摘要与token估算包含工具图片", async function recovery() {
    const { refs, store } = images(1, 3);
    const messages = normalizeAgentMessages(JSON.parse(JSON.stringify(toolHistory(refs))));
    const prepared = await prepareSessionImages(messages, store, "s", false, new Set());
    expect(prepared.imageData[refs[0].id].data).toBe("AAAA");
    expect(projectMessagesForSummary(messages)).toContain("引用不表示已观察");
    const textOnly = normalizeAgentMessages(JSON.parse(JSON.stringify(messages)));
    delete (textOnly.at(-1)!.content[0] as any).images;
    expect(estimateMessageTokens(messages)).toBeGreaterThan(estimateMessageTokens(textOnly) + 85);
    refs[0].sha256 = "b".repeat(64);
    await expect(prepareSessionImages(messages, store, "s", false, new Set())).rejects.toBeInstanceOf(SessionImageError);
    const invalid = JSON.parse(JSON.stringify(messages));
    invalid.at(-1).content[0].images = [{ type: "text", text: "伪造引用" }];
    expect(function rejectInvalid() { normalizeAgentMessages(invalid); }).toThrow("工具图片");
  });
});
