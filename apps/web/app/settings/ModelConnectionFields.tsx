/** 主模型连接字段：显式编辑协议、兼容预设和模型，不暴露凭据引用。 */
import type { MainSettingsInput } from "@/lib/settings/credential-settings";

/** 渲染主供应商、地址和明确可见的模型下拉，支持手填自定义模型。 */
export default function ModelConnectionFields({ value, onChange }: { value: MainSettingsInput; onChange: (value: MainSettingsInput) => void }) {
  const inputClass = "mt-2 w-full border-2 border-ink bg-bg px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent";
  const models = [...new Set(value.availableModels ?? [])];
  const configuredModel = models.includes(value.model);
  return <div className="mt-5 grid gap-4 sm:grid-cols-2">
    <label htmlFor="main-provider" className="font-semibold">供应商
      <select id="main-provider" value={value.provider} onChange={function changeProvider(event) {
        const provider = event.target.value as MainSettingsInput["provider"];
        const anthropic = (value.apiProtocol ?? "anthropic-messages") === "anthropic-messages";
        onChange({ ...value, provider, effort: "auto", ...(provider === "deepseek" ? { baseUrl: anthropic ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com/v1", compatibilityPreset: anthropic ? undefined : "deepseek" } : {}) });
      }} className={inputClass}>
        <option value="deepseek">DeepSeek</option>
        <option value="custom">自定义服务</option>
      </select>
    </label>
    <label htmlFor="main-protocol" className="font-semibold">API 协议
      <select id="main-protocol" value={value.apiProtocol ?? "anthropic-messages"} onChange={function changeProtocol(event) {
        const apiProtocol = event.target.value as MainSettingsInput["apiProtocol"];
        const anthropic = apiProtocol === "anthropic-messages";
        onChange({ ...value, apiProtocol, effort: "auto", compatibilityPreset: anthropic ? undefined : value.compatibilityPreset ?? (value.provider === "deepseek" ? "deepseek" : undefined), ...(value.provider === "deepseek" ? { baseUrl: anthropic ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com/v1" } : {}) });
      }} className={inputClass}>
        <option value="anthropic-messages">Anthropic Messages</option>
        <option value="openai-chat-completions">Chat Completions</option>
        <option value="openai-responses">Responses</option>
      </select>
    </label>
    {value.apiProtocol && value.apiProtocol !== "anthropic-messages" && <label htmlFor="main-compatibility" className="font-semibold">兼容预设
      <select id="main-compatibility" value={value.compatibilityPreset ?? ""} onChange={function changePreset(event) { onChange({ ...value, compatibilityPreset: event.target.value as MainSettingsInput["compatibilityPreset"] || undefined, effort: "auto" }); }} className={inputClass}>
        <option value="">沿用无预设配置</option>
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek</option>
        <option value="generic">通用兼容</option>
      </select>
      <span className="mt-2 block text-xs font-normal text-muted">按服务商选择兼容预设；已有模型能力声明由服务端保留。</span>
    </label>}
    <label htmlFor="main-model" className="font-semibold">当前模型
      <select id="main-model" value={configuredModel ? value.model : ""} onChange={function changeModel(event) { onChange({ ...value, model: event.target.value, effort: "auto" }); }} className={inputClass}>
        {models.map(function option(model) { return <option key={model} value={model}>{model}</option>; })}
        <option value="">手动填写模型 ID</option>
      </select>
    </label>
    {!configuredModel && <label htmlFor="main-custom-model" className="font-semibold">自定义模型 ID
      <input id="main-custom-model" value={value.model} onChange={function changeCustomModel(event) { onChange({ ...value, model: event.target.value, effort: "auto" }); }} required maxLength={240} placeholder="填写完整模型 ID" className={inputClass} />
    </label>}
    <label htmlFor="main-base-url" className="font-semibold sm:col-span-2">Base URL
      <input id="main-base-url" value={value.baseUrl} onChange={function changeBaseUrl(event) { onChange({ ...value, baseUrl: event.target.value, effort: "auto" }); }} required type="url" maxLength={2048} placeholder="https://api.example.com/v1" className={inputClass} />
      <span className="mt-2 block text-xs font-normal text-muted">填写服务基础地址；由所选协议追加 messages、chat/completions 或 responses 路径。</span>
    </label>
  </div>;
}
