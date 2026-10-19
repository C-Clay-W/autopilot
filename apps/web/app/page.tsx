/** 首页：提供对话入口与无需手工修改文件的模型/搜索配置入口。 */
"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

/** 首页 —— Autopilot Agent 产品入口 */
export default function Home() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-bg p-8">
      {/* header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-ink pb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent text-ink-on-dark flex items-center justify-center font-bold text-xl">
            T
          </div>
          <span className="font-bold text-lg">Autopilot</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/settings" className="border-2 border-ink px-4 py-2 text-sm font-bold text-accent hover:bg-ink hover:text-ink-on-dark">模型与搜索配置</Link>
          <button
            onClick={() => router.push("/chat")}
            className="px-4 py-2 bg-ink text-ink-on-dark font-bold border-2 border-ink hover:bg-ink-soft transition-colors text-sm"
          >
            开始 →
          </button>
        </div>
      </header>

      {/* 主体 */}
      <main className="max-w-3xl mx-auto mt-10">
        {/* Hero：辞典词条式 */}
        <h1 className="text-3xl font-bold">Autopilot Agent</h1>
        <p className="text-xs text-muted mt-1">
          /ˈɔː.təʊ.paɪ.lət ˈeɪ.dʒənt/ — <i>n.</i> — 自主 AI 工作伙伴
        </p>

        {/* 引用块 */}
        <blockquote className="border-[3px] border-ink p-6 mt-6 bg-card">
          <p className="text-ink">「不只是问答，让 AI 替你把事办了。」</p>
          <p className="text-right text-xs text-muted mt-3">
            —— Autopilot · 2026
          </p>
        </blockquote>

        <div className="divider-dotted" />

        {/* §1 核心能力 */}
        <h2 className="text-lg font-bold">§1 核心能力</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
          {[
            { label: "工具调用", desc: "读写文件、执行命令、操作数据" },
            { label: "知识检索", desc: "基于 LanceDB 的本地向量语义检索" },
            { label: "文件解析", desc: "Excel · PDF · Docx · Markdown 入库" },
            { label: "审批机制", desc: "敏感操作需人工确认，安全可控" },
            { label: "会话持久", desc: "对话自动保存，任务中断可恢复" },
            { label: "过程透明", desc: "实时展示 AI 思考链路与工具调用结果" },
          ].map((item) => (
            <div key={item.label} className="border-2 border-ink bg-card p-4">
              <h3 className="text-sm font-bold text-accent">{item.label}</h3>
              <p className="text-xs text-muted mt-1">{item.desc}</p>
            </div>
          ))}
        </div>

        <div className="divider-dotted" />

        {/* §2 安全边界 */}
        <h2 className="text-lg font-bold">§2 安全边界</h2>
        <p className="text-sm text-muted mt-2 leading-relaxed">
          Agent 执行敏感操作（文件写入、命令执行等）前会触发审批卡，由你决定允许或拒绝。
          支持「仅此一次」「本会话允许」「本工作区允许」三级授权粒度，
          兼顾安全与效率。
        </p>

        <div className="divider-dotted" />

        {/* CTA */}
        <div className="flex justify-center mt-10">
          <button
            onClick={() => router.push("/chat")}
            className="px-8 py-3 bg-accent text-ink-on-dark font-bold border-2 border-ink hover:bg-ink transition-colors"
          >
            开始对话
          </button>
        </div>
      </main>
    </div>
  );
}
