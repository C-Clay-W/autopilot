/** Node Chat capability loader 对交互 UI 开关的模式隔离契约。 */
import { describe, expect, it } from "vitest";
import { createNodeChatCapabilityLoader } from "./create-node-chat-capability-loader";
import type { NodeChatStorage } from "./create-node-chat-storage";

/** 构造只覆盖本测试调用面的最小 Chat storage。 */
function createStorage(retrievalMode: "none" | "web" | "rag" = "none") {
  return {
    ports: { sessionStore: {
      /** 返回与调用绑定模式一致的最小 Session 身份。 */
      async get(sessionId: string) { return { id: sessionId, productMode: "chat", chatRetrievalMode: retrievalMode }; },
    } },
    attachments: {
      /** 测试 Session 不处于删除屏障。 */
      isSessionDeleting() { return false; },
      /** 测试 Session 没有临时附件。 */
      async list() { return []; },
    },
  } as unknown as NodeChatStorage;
}

/** 确认交互 UI 仅由受信选项显式开启，且 loader 自身仍按持久模式收窄。 */
describe("Node Chat interactive UI capability", function nodeChatInteractiveUiSuite() {
  it("仅在开启选项和 Chat none/web 同时成立时装配能力", async function gatesCapabilityByHostOptionAndMode() {
    const storage = createStorage();
    const enabledLoader = createNodeChatCapabilityLoader({ storage, interactiveUi: true });
    const disabledLoader = createNodeChatCapabilityLoader({ storage, interactiveUi: false });
    const webLoader = createNodeChatCapabilityLoader({ storage: createStorage("web"), interactiveUi: true });
    const ragLoader = createNodeChatCapabilityLoader({ storage: createStorage("rag"), interactiveUi: true });

    expect(await enabledLoader({ sessionId: "session", turnId: "turn", retrievalMode: "none" })).toHaveProperty("interactiveUi", true);
    expect(await disabledLoader({ sessionId: "session", turnId: "turn", retrievalMode: "none" })).not.toHaveProperty("interactiveUi");
    expect(await webLoader({ sessionId: "session", turnId: "turn", retrievalMode: "web" })).toHaveProperty("interactiveUi", true);
    expect(await ragLoader({ sessionId: "session", turnId: "turn", retrievalMode: "rag" })).not.toHaveProperty("interactiveUi");
  });
});
