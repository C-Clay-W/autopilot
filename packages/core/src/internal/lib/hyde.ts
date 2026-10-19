/**
 * HyDE 查询改写：只生成一次假设文档供 Dense 重试使用，绝不作为事实上下文。
 */
import { askLLMWithImages, askLoopLLM } from "./llm";

/** 根据问题的视觉需求生成受控的 HyDE 假设文档。 */
export async function generateHydeQuery(question: string, requiresVision: boolean, signal?: AbortSignal): Promise<string | null> {
  const systemPrompt = "你是检索查询改写器。生成一段可能出现在目标资料中的简短假设文档，只输出正文，不要解释，也不能把假设当作事实。";
  const userMessage = `用户问题：${question}`;
  try {
    const content = requiresVision
      ? await askLLMWithImages(systemPrompt, userMessage, [], { temperature: 0, maxTokens: 256, thinking: "disabled", signal })
      : await askLoopLLM(systemPrompt, userMessage, { temperature: 0, maxTokens: 256, thinking: "disabled", signal });
    return content.trim() || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
