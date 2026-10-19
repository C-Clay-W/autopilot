/** 主模型连接字段：只编辑 Anthropic Messages 兼容地址与模型，不暴露内部路由。 */
import type { MainSettingsInput } from "@/lib/settings/credential-settings";

/** 渲染主供应商、地址和可手填的模型选择。 */
export default function ModelConnectionFields({ value, onChange }: { value: MainSettingsInput; onChange: (value: MainSettingsInput) => void }) {
  const inputClass = "mt-2 w-full border-2 border-ink bg-bg px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent";
  return <div className="mt-5 grid gap-4 sm:grid-cols-2">
    <label htmlFor="main-provider" className="font-semibold">供应商
      <select id="main-provider" value={value.provider} onChange={function changeProvider(event) {
        const provider = event.target.value as MainSettingsInput["provider"];
        onChange({ ...value, provider, ...(provider === "deepseek" ? { baseUrl: "https://api.deepseek.com/anthropic" } : {}) });
      }} className={inputClass}>
        <option value="deepseek">DeepSeek</option>
        <option value="custom">自定义 Anthropic 兼容服务</option>
      </select>
    </label>
    <label htmlFor="main-model" className="font-semibold">当前模型
      <input id="main-model" list="main-model-catalog" value={value.model} onChange={function changeModel(event) { onChange({ ...value, model: event.target.value }); }} required maxLength={240} placeholder="填写完整模型 ID" className={inputClass} />
      <datalist id="main-model-catalog">{value.availableModels?.map(function option(model) { return <option key={model} value={model} />; })}</datalist>
    </label>
    <label htmlFor="main-base-url" className="font-semibold sm:col-span-2">Anthropic Messages Base URL
      <input id="main-base-url" value={value.baseUrl} onChange={function changeBaseUrl(event) { onChange({ ...value, baseUrl: event.target.value }); }} required type="url" maxLength={2048} placeholder="https://api.example.com/anthropic" className={inputClass} />
      <span className="mt-2 block text-xs font-normal text-muted">填写基础地址，不包含 /v1/messages。图片理解默认继承此连接。</span>
    </label>
  </div>;
}
