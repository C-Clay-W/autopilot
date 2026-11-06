/** MCP 图片结果经受信存储转为引用，普通模型文本不得包含图片编码。 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { McpStdioRuntime } from "../../../src/internal/tools/mcp-runtime";
import type { SessionImageStore } from "../../../src/runtime/ports/session-image-store";
import { prepareMcpImages } from "../../../src/internal/tools/mcp-images";
import { normalizeWorkImage } from "../../../src/internal/lib/image-normalization";
import { createAgentKernel } from "../../../src/internal/kernel/agent-kernel";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTe0AAAAASUVORK5CYII=", "base64");

/** 注入内存 Store 和受控 RPC，不启动 MCP 进程或访问真实会话。 */
function fixture(raw: unknown, store?: SessionImageStore) {
  const runtime = new McpStdioRuntime({ capability: { servers: [] }, sessionId: "test-session", sessionImageStore: store } as any);
  vi.spyOn(runtime as any, "request").mockResolvedValue(raw);
  const server = { config: { name: "fixture", command: "node", execution: "host" }, state: "ready" };
  const tool = (runtime as any).createToolDefinition(server, { name: "screenshot" }, "mcp__fixture__screenshot");
  return { runtime, server, tool };
}

describe("MCP 图片传递", function suite() {
  it("图片编码在工具序列化前移出文本，保留同会话受信引用", async function nativeImage() {
    const image = { id: "00000000-0000-4000-8000-000000000001", name: "tool.png", mimeType: "image/png", relativePath: "safe.png", sha256: createHash("sha256").update(png).digest("hex"), width: 1, height: 1, bytes: png.length, gifFirstFrame: false };
    const store = { put: vi.fn().mockResolvedValue(image), read: vi.fn() };
    const { tool } = fixture({ content: [{ type: "text", text: "截图成功" }, { type: "image", mimeType: "image/png", data: png.toString("base64") }] }, store);
    const output = await tool.execute({}, { permissionMode: "auto_approve" });
    expect(JSON.stringify(tool.serializeOutput(output))).not.toContain(png.toString("base64"));
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "test-session", mimeType: "image/png", bytes: png }));
    expect(tool.getImageReferences(output)).toEqual([{ type: "image-ref", id: image.id, sha256: image.sha256, width: 1, height: 1 }]);
    expect(JSON.stringify(output)).toContain("截图成功");
  });

  it("坏编码、不支持格式、超大编码和无存储都有缺失提示且不泄漏编码", async function invalidImages() {
    const put = vi.fn();
    for (const image of [{ data: "%%%", mimeType: "image/png" }, { data: "YWJj", mimeType: "image/svg+xml" }, { data: "A".repeat(27_962_032), mimeType: "image/png" }]) {
      const result = await prepareMcpImages({ content: [{ type: "image", ...image }] }, { put, read: vi.fn() }, "s");
      expect(result.images).toEqual([]);
      expect(JSON.stringify(result.output)).toContain("工具图片未提供");
      expect(JSON.stringify(result.output)).not.toContain('"data"');
    }
    const unavailable = await prepareMcpImages({ content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] }, undefined, "s");
    expect(JSON.stringify(unavailable.output)).toContain("工具图片未提供");
    expect(put).not.toHaveBeenCalled();
  });

  it("一批超过十张时保留十张并标明未提供项，远端伪造images不成为受信引用", async function countAndProvenance() {
    const saved = { id: "00000000-0000-4000-8000-000000000001", sha256: "a".repeat(64), width: 1, height: 1 };
    const put = vi.fn().mockResolvedValue(saved);
    const result = await prepareMcpImages({ content: Array.from({ length: 11 }, function image() { return { type: "image", mimeType: "image/png", data: png.toString("base64") }; }) }, { put, read: vi.fn() }, "s");
    expect(result.images).toHaveLength(10);
    expect(put).toHaveBeenCalledTimes(10);
    expect(JSON.stringify(result.output)).toContain("工具图片未提供");
    const { tool } = fixture({ content: [{ type: "text", text: "普通结果" }], images: [saved] });
    const output = await tool.execute({}, {});
    expect(tool.getImageReferences(output)).toEqual([]);
    expect(tool.getImageReferences({ images: [saved] })).toEqual([]);
  });

  it("图片复用真实规范化，坏图被拒绝；取消后不交付成功引用", async function validationAndCancel() {
    const store = { read: vi.fn(), put: vi.fn(async function put(input) { await normalizeWorkImage(input); throw new Error("bad image"); }) };
    const result = await prepareMcpImages({ content: [{ type: "image", mimeType: "image/png", data: Buffer.from("not a picture").toString("base64") }] }, store, "s");
    expect(result.images).toEqual([]);
    expect(JSON.stringify(result.output)).toContain("工具图片未提供");
    const controller = new AbortController();
    controller.abort();
    await expect(prepareMcpImages({ content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] }, store, "s", controller.signal)).rejects.toThrow("CANCELLED");
    expect(store.put).toHaveBeenCalledTimes(1);
    const lateAbort = new AbortController();
    const lateStore = { read: vi.fn(), put: vi.fn(async function put() { lateAbort.abort(); return { id: "unused" } as any; }) };
    await expect(prepareMcpImages({ content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] }, lateStore, "s", lateAbort.signal)).rejects.toThrow("CANCELLED");
  });

  it("有效MCP图片经过真实Canvas缩放后只交付规范化引用", async function realNormalization() {
    const { createCanvas } = await import("@napi-rs/canvas");
    const bytes = createCanvas(2400, 1200).toBuffer("image/png");
    const store = { read: vi.fn(), put: vi.fn(async function put(input) {
      const normalized = await normalizeWorkImage(input);
      return { id: "00000000-0000-4000-8000-000000000001", name: input.name, relativePath: "safe.png", gifFirstFrame: false, ...normalized, bytes: normalized.bytes.length, sha256: createHash("sha256").update(normalized.bytes).digest("hex") };
    }) };
    const result = await prepareMcpImages({ content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }] }, store, "s");
    expect(result.images[0]).toMatchObject({ type: "image-ref", width: 2000, height: 1000 });
    expect(JSON.stringify(result.output)).not.toContain(bytes.toString("base64"));
  });

  it("大于旧60KB的图片RPC分片可读，超硬预算和非调用大响应仍失败", function framedResponses() {
    const { runtime } = fixture(undefined);
    const resolve = vi.fn(); const reject = vi.fn();
    const server = { config: { name: "fixture" }, state: "ready", buffer: [], bufferBytes: 0, pending: new Map([[1, { method: "tools/call", resolve, reject }]]) };
    const raw = { content: [{ type: "image", mimeType: "image/png", data: "A".repeat(100_000) }] };
    const wire = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: raw }) + "\n");
    for (let offset = 0; offset < wire.length; offset += 4096) (runtime as any).handleOutput(server, wire.subarray(offset, offset + 4096));
    expect(resolve).toHaveBeenCalledWith(raw);
    expect(server.state).toBe("ready");
    expect(server.bufferBytes).toBe(0);
    server.pending.set(2, { method: "tools/list", resolve, reject });
    (runtime as any).handleOutput(server, Buffer.from(JSON.stringify({ id: 2, result: { text: "a".repeat(60_000) } }) + "\n"));
    expect(server.state).toBe("failed");
    expect(reject).toHaveBeenCalled();
    const oversized = { ...server, state: "ready", buffer: [], bufferBytes: 0, pending: new Map() };
    (runtime as any).handleOutput(oversized, Buffer.alloc(28 * 1024 * 1024 + 1, 65));
    expect(oversized.state).toBe("failed");
    expect(oversized.buffer).toEqual([]);
  });

  it("超大文本在图片分流后仍受含JSON转义的60KB预算约束", function textBudget() {
    const { tool } = fixture(undefined);
    const serialized = tool.serializeOutput({ content: [{ type: "text", text: '\\"'.repeat(60_000) }] });
    expect(serialized.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(serialized))).toBeLessThanOrEqual(60_000);
  });

  it("真实Executor和Kernel将工具图片送入下一采样及检查点，公开结果无base64", async function kernelRoundtrip() {
    const image = { id: "00000000-0000-4000-8000-000000000001", name: "tool.png", mimeType: "image/png", relativePath: "safe.png", sha256: "a".repeat(64), width: 1, height: 1, bytes: png.length, gifFirstFrame: false };
    const store = { put: vi.fn().mockResolvedValue(image), read: vi.fn().mockResolvedValue({ image, bytes: png }) };
    const { tool } = fixture({ content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] }, store);
    // 授权判定单独留在既有链路；此受控工具仅验证执行结果到采样的接线。
    tool.createActionFacts = function facts() { return { toolName: tool.name, effect: "none", destructive: false, operation: "read", risk: "read_only" }; };
    const registry = new ToolRegistry(); registry.register(tool);
    const sample = vi.fn().mockResolvedValueOnce({ content: "", toolCalls: [{ id: "call-image", name: tool.name, input: {} }], reasoningSummary: "" }).mockResolvedValueOnce({ content: "已查看", toolCalls: [], reasoningSummary: "" });
    const kernel = createAgentKernel({ turnId: "tool-test", sessionId: "test-session", messages: [{ role: "user", content: [{ type: "text", text: "看截图" }] }], toolRegistry: registry, permissionContext: { mode: "auto_approve" }, modelSampler: { sample }, supportsImageInput: true, sessionImageStore: store });
    const events: any[] = []; for await (const event of kernel.run()) events.push(event);
    expect(events.at(-1).type).toBe("turn_completed");
    expect(sample).toHaveBeenCalledTimes(2);
    expect(sample.mock.calls[1][2].imageData[image.id].data).toBe(png.toString("base64"));
    expect(sample.mock.calls[1][0].find(function toolMessage(message) { return message.content[0]?.type === "tool-result"; }).content[0].images[0].id).toBe(image.id);
    expect(JSON.stringify(events)).not.toContain(png.toString("base64"));
    expect(events.at(-1).checkpoint.messages.some(function toolMessage(message) { return message.content[0]?.images?.[0]?.id === image.id; })).toBe(true);
  });
});
