/**
 * runtime/provider/vision-analyzer.ts — 注入式视觉调用能力
 *
 * 视觉工具按冻结协议复用主连接或显式视觉连接，不读取全局模型环境变量。
 */

import type { ResolvedCredential } from "../domain";
import type { FrozenVisionConfig } from "./frozen-provider-config";

/** 视觉工具使用的最小调用端口。 */
export interface VisionAnalyzer {
  analyze(input: { systemPrompt: string; prompt: string; imageDataUrl: string; signal?: AbortSignal }): Promise<string>;
}

/** 创建由已冻结路由和按需凭据解析器驱动的视觉能力。 */
export function createVisionAnalyzer(
  config: FrozenVisionConfig,
  resolveCredential: () => Promise<ResolvedCredential | undefined>,
  fetchImplementation: typeof fetch = fetch,
): VisionAnalyzer {
  return {
    async analyze(input) {
      if (!config.baseUrl || !config.credentialRef) throw new Error("VISION_CAPABILITY_UNAVAILABLE");
      const credential = await resolveCredential();
      if (!credential) throw new Error("VISION_CAPABILITY_UNAVAILABLE");
      if (config.apiProtocol === "anthropic-messages") {
        const match = /^data:([^;,]+);base64,(.+)$/u.exec(input.imageDataUrl);
        if (!match) throw new Error("VISION_IMAGE_INVALID");
        const usesBearer = config.credentialRef.key === "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN";
        const response = await fetchImplementation(`${config.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(usesBearer ? { authorization: `Bearer ${credential.apiKey}` } : { "x-api-key": credential.apiKey }),
          },
          body: JSON.stringify({
            model: config.ref.modelId,
            max_tokens: 1_500,
            temperature: 0,
            system: input.systemPrompt,
            messages: [{ role: "user", content: [
              { type: "text", text: input.prompt },
              { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } },
            ] }],
          }),
          signal: input.signal,
        });
        if (!response.ok) throw new Error(`VISION_PROVIDER_REJECTED: ${response.status}`);
        const payload = await response.json() as { content?: Array<{ type?: unknown; text?: unknown }> };
        const observation = payload.content?.filter(function text(block) { return block.type === "text" && typeof block.text === "string"; }).map(function value(block) { return block.text; }).join("\n");
        if (!observation?.trim()) throw new Error("VISION_PROVIDER_EMPTY_RESPONSE");
        return observation;
      }
      const response = await fetchImplementation(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.apiKey}` },
        body: JSON.stringify({
          model: config.ref.modelId,
          temperature: 0,
          max_tokens: 1_500,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: [{ type: "text", text: input.prompt }, { type: "image_url", image_url: { url: input.imageDataUrl } }] },
          ],
        }),
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`VISION_PROVIDER_REJECTED: ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const observation = payload.choices?.[0]?.message?.content;
      if (typeof observation !== "string" || !observation.trim()) throw new Error("VISION_PROVIDER_EMPTY_RESPONSE");
      return observation;
    },
  };
}
