/** 验证图片引用在两种 Provider 协议边界转换及缺失字节处理。 */
import { describe, expect, it } from 'vitest';
import { createAnthropicMessagesRequest } from '../../src/runtime/provider/anthropic-messages-adapter';
import { createOpenAiChatCompletionsMessages } from '../../src/runtime/provider/openai-chat-completions-adapter';
import type { AgentMessage } from '../../src/internal/types/agent-message';
const id = '00000000-0000-4000-8000-000000000001';
const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image-ref', id, sha256: 'a'.repeat(64), width: 4, height: 4 }] }];
const data = { [id]: { mimeType: 'image/png' as const, data: 'YWJj' } };
const profile = { apiProtocol: 'openai-chat-completions' as const, assistantToolCallContent: 'empty-string' as const, supportsReasoningContent: false, supportsUsageInStreaming: false };
describe('图片协议', function imageProtocols() {
  it('Chat Completions 按顺序编码文本和图片', function chatWire() {
    expect(createOpenAiChatCompletionsMessages(messages, profile, data)).toEqual([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }]);
    expect(function missing() { createOpenAiChatCompletionsMessages(messages, profile); }).toThrow();
  });
  it('Anthropic 使用 Base64 图片块', function anthropicWire() {
    const request = createAnthropicMessagesRequest('test', messages, [], {}, 100, false, 'none', data);
    expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] }]);
    expect(function missing() { createAnthropicMessagesRequest('test', messages, [], {}, 100); }).toThrow();
  });
});
