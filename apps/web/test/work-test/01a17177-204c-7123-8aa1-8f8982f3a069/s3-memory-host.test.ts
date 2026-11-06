/** S3 受信存储注入回归：同一 Host 内存保留消息/UI/续聊，默认 durable 路径仍可使用。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPorts, type AgentEvent, type ModelSampler } from "@autopilot-agent/core";
import { createWebChatHost } from "@/lib/runtime-host/web-chat-host";
import { createS3MemoryChatStorage } from "../../helpers/s3-memory-chat-storage";

/** 每例把空 home 与状态路径放在测试归属目录，保留证据且不访问真实用户 settings。 */
function fixtureRoot(): string {
  const base = path.resolve("../../.agent-tests/work-test/01a17177-204c-7123-8aa1-8f8982f3a069/runs/host-injection-fixtures");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "case-"));
  fs.mkdirSync(path.join(root, "home"));
  return root;
}

describe("S3 trusted Host storage injection", function suite() {
  it("内存存储保留真实Runtime的UI消息和同会话新Turn，磁盘不生成状态", async function memoryHost() {
    const root = fixtureRoot();
    const credentials = createMemoryPorts().credentialStore;
    const storage = createS3MemoryChatStorage(path.join(root, "memory-state"), credentials);
    let samples = 0;
    const sampler: ModelSampler = {
      /** 首步交付最小UI，其后文字收口；第二Turn检验同会话消息仍可消费。 */
      async sample(messages, _tools, _options, onDelta) {
        samples++;
        if (samples === 1) return {
          content: "", reasoningSummary: "", toolCalls: [{ id: "memory-ui-call", name: "render_ui", input: {
            title: "S3_MEMORY_ONLY_CANARY", fallbackText: "合成说明",
            spec: { root: "text", elements: { text: { type: "Text", props: { value: "合成说明", size: "md", tone: "ink" } } } },
          } }],
        };
        if (samples === 3) expect(JSON.stringify(messages)).toContain("S3_MEMORY_ONLY_CANARY");
        onDelta?.("普通文字收口");
        return { content: "普通文字收口", reasoningSummary: "", toolCalls: [] };
      },
    };
    const host = await createWebChatHost({ storage, homeDirectory: path.join(root, "home"), env: { NODE_ENV: "test" }, modelSampler: sampler });
    try {
      expect(host.storage).toBe(storage);
      expect(host.storage.ports.credentialStore).toBe(credentials);
      await host.runtime.sessions.create({ id: "s3-memory-host", productMode: "chat", chatRetrievalMode: "none" });
      const events: AgentEvent[] = [];
      for await (const event of host.runtime.turns.start({ sessionId: "s3-memory-host", content: "生成UI", runConfig: { maxSteps: 3, maxToolRetries: 0, toolAllowlist: ["render_ui"] } })) events.push(event);
      expect(events.at(-1)?.type).toBe("turn_completed");
      expect(events.filter(function isUi(event) { return event.type === "ui_document"; })).toHaveLength(1);
      const continuation: AgentEvent[] = [];
      for await (const event of host.runtime.turns.start({ sessionId: "s3-memory-host", content: "基于以上界面继续说明", runConfig: { maxSteps: 3, maxToolRetries: 0, toolAllowlist: [] } })) continuation.push(event);
      expect(continuation.at(-1)?.type).toBe("turn_completed");
      expect(samples).toBe(3);
      expect(JSON.stringify(await storage.ports.checkpointStore.getLatest("s3-memory-host"))).toContain("S3_MEMORY_ONLY_CANARY");
      expect((await storage.ports.transcriptStore.getEvents("s3-memory-host")).some(function isUi(envelope) { return envelope.event.type === "ui_document"; })).toBe(true);
    } finally { host.stop(); }
    expect(fs.existsSync(path.join(root, "memory-state"))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(["home"]);
  });

  it("未注入时沿用Node durable存储，不改变默认生产装配", async function defaultStorage() {
    const root = fixtureRoot();
    const host = await createWebChatHost({ globalStateRoot: path.join(root, "durable"), homeDirectory: path.join(root, "home"), env: { NODE_ENV: "test" }, modelSampler: {
      /** 默认存储用例不调用Provider。 */
      async sample() { return { content: "合成回答", reasoningSummary: "", toolCalls: [] }; },
    } });
    try {
      await host.runtime.sessions.create({ id: "s3-default-host", productMode: "chat", chatRetrievalMode: "none" });
      expect(fs.existsSync(host.storage.paths.stateRoot)).toBe(true);
      expect((await host.storage.ports.sessionStore.get("s3-default-host"))?.id).toBe("s3-default-host");
    } finally { host.stop(); }
  });
});
