/** 设置中心页面：主模型可编辑，RAG 配置仅读取展示并由 settings 文件维护。 */
"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { WEB_SEARCH_DATA_FLOW_NOTICE } from "@autopilot-agent/presentation";
import type { CredentialSettingsStatus, MainSettingsInput, RagConnectionInput, RagRole, SearchSettingsInput } from "@/lib/settings/credential-settings";
import ModelConnectionFields from "./ModelConnectionFields";

type Category = "main" | "rag";

const RAG_LABELS: Record<RagRole, { title: string; description: string; embedding: boolean }> = {
  textRerank: { title: "文本 Rerank", description: "重排文本检索候选。", embedding: false },
  visionRerank: { title: "视觉 Rerank", description: "重排 PDF 页面与图片候选。", embedding: false },
  textEmbedding: { title: "文本 Embedding", description: "生成文本向量空间。", embedding: true },
  multimodalEmbedding: { title: "多模态 Embedding", description: "生成图片与页面向量空间。", embedding: true },
};

/** 只接受站内聊天地址，保存后返回原会话。 */
function getReturnUrl(value: string | null): string {
  return value === "/chat" || value?.startsWith("/chat?") ? value : "/chat";
}

/** Search 连接供应商的只读展示名；连接本体由 settings.json 唯一决定。 */
const SEARCH_PROVIDER_LABELS: Record<SearchSettingsInput["provider"], string> = {
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI Responses 兼容",
  "xiaomi-mimo": "小米 MiMo",
};

/** 只有 DeepSeek 官方 Anthropic 主地址允许 Search 复用主 Key。 */
function canReuseMainSearchKey(main?: MainSettingsInput): boolean {
  return Boolean(main?.provider === "deepseek" && main.baseUrl === "https://api.deepseek.com/anthropic");
}

/** 把安全状态复制为只读 RAG 展示值，Key 始终不进入浏览器状态。 */
function createRagDraft(status: CredentialSettingsStatus): Record<RagRole, RagConnectionInput> {
  return Object.fromEntries((Object.keys(RAG_LABELS) as RagRole[]).map(function entry(role) {
    const connection = status.rag[role];
    return [role, { provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model, ...(connection.dimension ? { dimension: connection.dimension } : {}) }];
  })) as Record<RagRole, RagConnectionInput>;
}

/** 渲染单个只读 RAG 角色连接，不把四类凭据或厂商混为一项。 */
function RagConnectionCard({ role, value, configured }: {
  role: RagRole;
  value: RagConnectionInput;
  configured: boolean;
}) {
  const meta = RAG_LABELS[role];
  const inputClass = "mt-2 w-full border-2 border-ink bg-bg px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";
  return <section className="border-2 border-ink bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-bold">{meta.title}</h3><p className="mt-1 text-xs text-muted">{meta.description}</p></div>
      <span className={`text-xs font-semibold ${configured ? "text-muted" : "text-error"}`}>{configured ? "已配置" : "未配置"}</span>
    </div>
    <fieldset disabled className="mt-4 grid gap-4 opacity-75 sm:grid-cols-2">
      <label className="font-semibold">供应商<input value={value.provider} readOnly className={inputClass} /></label>
      <label className="font-semibold">模型<input value={value.model} readOnly className={inputClass} /></label>
      <label className="font-semibold sm:col-span-2">Base URL<input value={value.baseUrl} readOnly type="url" className={inputClass} /></label>
      {meta.embedding && <label className="font-semibold">向量维度<input type="number" value={value.dimension ?? ""} readOnly className={inputClass} /></label>}
      <p className={`self-end text-sm font-semibold ${meta.embedding ? "" : "sm:col-span-2"}`}>API Key：{configured ? "已配置（不回显）" : "未配置"}</p>
    </fieldset>
    {meta.embedding && <p className="mt-4 border-l-4 border-accent pl-3 text-xs leading-relaxed text-muted">RAG 连接只允许在用户 settings 文件中配置；修改地址、模型或维度后，需要按新配置重新入库相关资料。Web 页面只展示当前状态，不会修改或重建索引。</p>}
  </section>;
}

/** 设置中心表单；切换分类保留浏览器草稿，各分类单独提交 revision。 */
function SettingsCenter() {
  const params = useSearchParams();
  const returnUrl = getReturnUrl(params.get("returnTo"));
  const [category, setCategory] = useState<Category>("main");
  const [status, setStatus] = useState<CredentialSettingsStatus>();
  const [main, setMain] = useState<MainSettingsInput>();
  const [search, setSearch] = useState<SearchSettingsInput>();
  const [rag, setRag] = useState<Record<RagRole, RagConnectionInput>>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [replacingMainKey, setReplacingMainKey] = useState(false);
  const [modelCatalogNotice, setModelCatalogNotice] = useState("");
  const [error, setError] = useState("");
  const [savedCategory, setSavedCategory] = useState<Category>();
  /** 已保存 Key 以灰色密码掩码展示；进入更换模式才允许输入新 Key。 */
  const mainKeyLocked = Boolean(status?.main.configured) && !replacingMainKey;

  /** 进入/退出主模型 Key 更换模式；退出时清空半输入的新 Key，留空保存即保留现有 Key。 */
  function toggleReplaceMainKey(): void {
    setReplacingMainKey((current) => !current);
    setMain((draft) => {
      if (!draft || !replacingMainKey) return draft;
      const { apiKey, ...rest } = draft;
      void apiKey;
      return rest;
    });
  }

  /** 用服务端安全状态刷新表单，任何凭据输入都不从响应恢复。 */
  function applyStatus(data: CredentialSettingsStatus, saved?: Category): void {
    setStatus(data);
    if (!saved || saved === "main") {
      const { configured: mainConfigured, ...mainDraft } = data.main;
      const { configured: searchConfigured, ...searchDraft } = data.search;
      void mainConfigured;
      void searchConfigured;
      setMain(mainDraft);
      setSearch(searchDraft);
    }
    if (!saved || saved === "rag") {
      setRag(createRagDraft(data));
    }
  }

  useEffect(function loadSettings() {
    const controller = new AbortController();
    /** 读取不含 Key 的设置状态。 */
    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/settings/credentials", { cache: "no-store", signal: controller.signal });
        console.log(response);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法读取配置，请刷新后重试。");
        if (!controller.signal.aborted) applyStatus(data);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取配置，请刷新后重试。");
      }
    }
    void load();
    return function cancelLoad() { controller.abort(); };
  }, []);

  /** 主动刷新 DeepSeek 模型目录；成功与回退都给出明确来源反馈，不再静默替换 datalist。 */
  async function refreshModelCatalog(): Promise<void> {
    if (!main || refreshingModels) return;
    setRefreshingModels(true);
    setError("");
    try {
      const response = await fetch(`/api/settings/models?provider=${encodeURIComponent(main.provider)}`, { cache: "no-store" });
      console.log(response);
      const data = await response.json() as { models?: string[]; source?: "official" | "maintained"; error?: string };
      if (!response.ok) throw new Error(data.error || "模型列表刷新失败。");
      const models = data.models ?? [];
      setMain({ ...main, availableModels: models });
      const sourceText = data.source === "official" ? "已从 DeepSeek 官方获取" : "上游不可用，使用维护目录";
      setModelCatalogNotice(`${sourceText} ${models.length} 个模型：${models.join("、")}`);
    } catch (cause) {
      setModelCatalogNotice("");
      setError(cause instanceof Error ? cause.message : "模型列表刷新失败，仍可手动填写。");
    }
    finally { setRefreshingModels(false); }
  }

  /** 保存主模型分类，同时原子保存已完成独立连接配置的 Search。 */
  async function saveMain(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!main || !search || busy) return;
    await savePayload({ category: "main", revision: status?.revision, main, search }, "main");
  }

  /** 提交一个分类并刷新服务端状态；失败保留当前草稿。 */
  async function savePayload(payload: unknown, saved: Category): Promise<void> {
    setBusy(true);
    setError("");
    setSavedCategory(undefined);
    try {
      const response = await fetch("/api/settings/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      console.log(response);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败，请稍后重试。");
      applyStatus(data, saved);
      setSavedCategory(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请检查网络后重试。"); }
    finally { setBusy(false); }
  }

  const inputClass = "mt-2 w-full border-2 border-ink bg-bg px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";
  return <main className="mx-auto min-h-screen max-w-6xl p-4 text-sm text-ink sm:p-6">
    <Link href={returnUrl} className="text-accent underline">← 返回对话</Link>
    <header className="mt-4 border-b-[3px] border-ink pb-4"><p className="mb-2 text-xs font-bold text-accent">AUTOPILOT · 设置</p><h1 className="text-2xl font-bold">设置中心</h1><p className="mt-2 text-muted">主模型与 RAG 独立保存；新配置从下一次调用边界生效。</p></header>
    <div className="mt-6 grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="设置分类" className="h-fit border-2 border-ink bg-card p-2">
        {(["main", "rag"] as Category[]).map(function item(id) { return <button key={id} type="button" onClick={function select() { setCategory(id); setError(""); setSavedCategory(undefined); }} aria-current={category === id ? "page" : undefined} className={`w-full px-3 py-3 text-left font-bold ${category === id ? "bg-ink text-ink-on-dark" : "hover:bg-accent/10"}`}>{id === "main" ? "主模型" : "RAG"}</button>; })}
      </nav>
      <div className="min-w-0 space-y-4">
        {error && <div role="alert" className="border-2 border-error bg-error/10 p-4 text-error">{error}</div>}
        {status && status.diagnostics.length > 0 && <section role="alert" className="border-2 border-error bg-error/10 p-4">
          <p className="font-semibold text-error">权限配置未生效（模型字段不受影响）</p>
          <ul className="mt-2 space-y-1 text-xs">
            {status.diagnostics.map(function item(diagnostic) { return <li key={`${diagnostic.code}:${diagnostic.field ?? ""}`}>错误码 <span className="font-semibold">{diagnostic.code}</span>{diagnostic.field ? <>，字段 <span className="font-semibold">{diagnostic.field}</span></> : null}（作用域 {diagnostic.scope}）</li>; })}
          </ul>
          <p className="mt-2 text-xs leading-relaxed">本项目不消费 Claude Code 的 defaultMode、Bash 等工具权限写法，也不会据此授权；如需外部文件授权，请使用 Write|Edit|Read(绝对路径) 写法。</p>
          {status.diagnostics.some(function restricted(diagnostic) { return diagnostic.code === "SETTINGS_PERMISSIONS_UNSAFE" || diagnostic.code === "SETTINGS_PERMISSIONS_INVALID"; }) && <p className="mt-1 text-xs font-semibold leading-relaxed">deny/ask 无法解释，外部文件操作一律拒绝，直到修正该字段。</p>}
          <p className="mt-1 text-xs leading-relaxed">请直接编辑 ~/.autopilot/settings.json 后刷新本页；保存模型配置不会删除或改写该段。</p>
        </section>}
        {savedCategory === category && <div role="status" className="border-2 border-accent bg-accent/10 p-4 font-semibold">主模型配置已保存</div>}
        {!status && !error && <p role="status" className="text-muted">正在读取配置…</p>}
        {status && category === "main" && main && search && <form onSubmit={saveMain} className="space-y-5">
          <section className="border-2 border-ink bg-card p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">主模型</h2><span className={status.main.configured ? "text-muted" : "font-semibold text-error"}>{status.main.configured ? "已配置" : "未配置"}</span></div><ModelConnectionFields value={main} onChange={function change(value) { setMain(value); setSavedCategory(undefined); setModelCatalogNotice(""); }} />
            <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 font-semibold">主模型 API Key<input type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} disabled={mainKeyLocked} required={!status.main.configured} value={main.apiKey ?? ""} onChange={function change(event) { setMain({ ...main, apiKey: event.target.value }); }} placeholder={mainKeyLocked ? "••••••••••（已保存，不回显）" : status.main.configured ? "留空保留现有 Key" : "输入主模型 Key"} className={inputClass} /></label>{status.main.configured && <button type="button" onClick={toggleReplaceMainKey} className="border-2 border-ink px-3 py-2 font-semibold">{replacingMainKey ? "取消更换" : "更换 Key"}</button>}<button type="button" onClick={refreshModelCatalog} disabled={refreshingModels || main.provider !== "deepseek"} className="border-2 border-ink px-3 py-2 font-semibold disabled:opacity-50">{refreshingModels ? "刷新中…" : "刷新模型列表"}</button></div>
            {modelCatalogNotice && <p role="status" className="mt-2 text-xs text-muted">{modelCatalogNotice}</p>}
            <p className="mt-3 text-xs text-muted">普通文本与 Chat/Work/RAG 图片理解共用此 Anthropic Messages 连接；Key 不回显。</p>
          </section>
          <section className="border-2 border-ink bg-card p-5"><button type="button" aria-expanded={advancedOpen} onClick={function toggleAdvanced() { setAdvancedOpen(!advancedOpen); }} className="w-full text-left font-bold">高级配置 {advancedOpen ? "−" : "+"}</button>{advancedOpen && <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="font-semibold sm:col-span-2">可选模型（每行一个）<textarea value={(main.availableModels ?? []).join("\n")} onChange={function change(event) { setMain({ ...main, availableModels: event.target.value.split(/\r?\n/u).filter(Boolean) }); }} rows={4} className={inputClass} /></label>
            {(["opusModel", "sonnetModel", "haikuModel", "subagentModel"] as const).map(function alias(key) { return <label key={key} className="font-semibold">{key === "subagentModel" ? "子 Agent 模型" : `${key.replace("Model", "")} 别名模型`}<input value={main[key] ?? ""} onChange={function change(event) { setMain({ ...main, [key]: event.target.value || undefined }); }} maxLength={240} className={inputClass} /></label>; })}
            <label className="font-semibold">思考强度<select value={main.effort ?? "auto"} onChange={function change(event) { setMain({ ...main, effort: event.target.value as MainSettingsInput["effort"] }); }} className={inputClass}>{["auto", "low", "medium", "high", "max"].map(function effort(value) { return <option key={value}>{value}</option>; })}</select></label>
            <label className="font-semibold">单次最大输出 Token<input type="number" min={1} max={1000000} placeholder="8192（默认）" value={main.maxOutputTokens ?? ""} onChange={function change(event) { setMain({ ...main, maxOutputTokens: event.target.value ? Number(event.target.value) : undefined }); }} className={inputClass} /></label>
            <label className="font-semibold">自动压缩窗口（Token）<input type="number" min={1} max={10000000} value={main.compactWindow ?? ""} onChange={function change(event) { setMain({ ...main, compactWindow: event.target.value ? Number(event.target.value) : undefined }); }} className={inputClass} /></label>
            <label className="font-semibold">请求超时（ms）<input type="number" min={1000} max={600000} value={main.timeoutMs ?? ""} onChange={function change(event) { setMain({ ...main, timeoutMs: event.target.value ? Number(event.target.value) : undefined }); }} className={inputClass} /></label>
            <label className="flex items-center gap-2 self-end pb-3 font-semibold"><input type="checkbox" checked={main.alwaysThinkingEnabled ?? false} onChange={function change(event) { setMain({ ...main, alwaysThinkingEnabled: event.target.checked }); }} className="accent-accent" />始终启用思考</label>
          </div>}</section>
          <section className="border-2 border-ink bg-card p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">网络搜索</h2><span className={search.enabled && !status.search.configured ? "font-semibold text-error" : "text-muted"}>{!search.enabled ? "未启用" : status.search.configured ? "已配置" : "待配置"}</span></div><label className="mt-4 flex items-center gap-2 font-semibold"><input type="checkbox" checked={search.enabled} onChange={function change(event) { setSearch({ ...search, enabled: event.target.checked }); }} className="accent-accent" />启用网络搜索</label>{search.enabled && <div className="mt-4 space-y-4 border-t border-dotted border-ink pt-4">
            {canReuseMainSearchKey(main) && <label className="flex items-center gap-2"><input type="checkbox" checked={search.useMainKey} onChange={function change(event) { setSearch({ ...search, useMainKey: event.target.checked }); }} className="accent-accent" />复用 DeepSeek 官方主 Key</label>}
            {(!search.useMainKey || !canReuseMainSearchKey(main)) && <><label className="block font-semibold">搜索供应商<input value={SEARCH_PROVIDER_LABELS[search.provider] ?? search.provider} readOnly className={inputClass} /></label><label className="block font-semibold">Search Base URL<input type="url" value={search.baseUrl} readOnly className={inputClass} /></label><label className="block font-semibold">搜索模型<input value={search.model} readOnly className={inputClass} /></label><p className="text-xs text-muted">搜索连接由 ~/.autopilot/settings.json 决定，此处只读展示；如需更换供应商或模型，请直接编辑该文件。下方仅填写或更换 Key。</p><label className="block font-semibold">Search API Key<input type="password" autoComplete="new-password" value={search.apiKey ?? ""} onChange={function change(event) { setSearch({ ...search, apiKey: event.target.value }); }} required={!status.search.configured} placeholder={status.search.configured ? "连接不变时留空保留" : "输入当前供应商 Key"} className={inputClass} /></label></>}
            <p className="border-l-4 border-accent pl-3 text-xs leading-relaxed text-muted">{WEB_SEARCH_DATA_FLOW_NOTICE}</p>
          </div>}</section>
          <button disabled={busy} className="border-2 border-ink bg-accent px-6 py-3 font-bold text-ink-on-dark disabled:cursor-wait">{busy ? "正在保存…" : "保存主模型"}</button>
        </form>}
        {status && category === "rag" && rag && <section className="space-y-5"><header><h2 className="text-lg font-bold">RAG 专用模型</h2><p className="mt-1 text-xs text-muted">此处只读展示四个角色的当前连接。请直接编辑 `~/.autopilot/settings.json` 后刷新；Web 不提供 RAG 修改、Key 输入或索引重建。</p></header>{(Object.keys(RAG_LABELS) as RagRole[]).map(function card(role) { return <RagConnectionCard key={role} role={role} value={rag[role]} configured={status.rag[role].configured} />; })}</section>}
      </div>
    </div>
  </main>;
}

/** 将 URL 参数读取放入 Suspense，兼容 Next 静态页面边界。 */
export default function SettingsPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-muted">正在读取配置…</p>}><SettingsCenter /></Suspense>;
}
