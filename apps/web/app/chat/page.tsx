/** 对话页面：Chat 与 Work 共用会话、SSE 和历史展示，按产品限定入口与操作能力。 */
"use client";

import { Suspense } from "react";
import SessionChatHost from "./chat-session-host";

/** 为使用 useSearchParams 的聊天内容提供 Next.js 构建所需的 Suspense 边界。 */
export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <SessionChatHost />
    </Suspense>
  );
}
