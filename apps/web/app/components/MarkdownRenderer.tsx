/** 标准 Markdown/GFM 回答渲染：纸本样式、代码复制、外链确认及 Chat RAG 受控来源预览。 */
"use client";

import { Children, isValidElement, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import ExternalLinkDialog from "./ExternalLinkDialog";
import SourceImageDialog from "./SourceImageDialog";
import { normalizeExternalLink, trimLinkPunctuation } from "./external-link";
import { formatRagTables } from "./rag-table-markdown";

interface Props {
  content: string;
  /** 仅 Chat RAG 的回答启用知识图片与 canonical 表格格式化。 */
  ragEvidence?: boolean;
}

/** 图片仅允许当前站点的知识预览端点，不加载模型提供的外部网址或任意本地路径。 */
function isKnowledgeImage(url: string): boolean {
  return /^\/api\/chat\/knowledge\/resource_[a-f0-9]{32}\/preview(?:\/pages\/[1-9]\d{0,5})?$/.test(url);
}

/** 提取代码子节点的字面文本，复制时不带格式化标记或按钮文字。 */
function plainText(children: ReactNode): string {
  return Children.toArray(children).map(function text(child): string {
    return isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : typeof child === "string" || typeof child === "number" ? String(child) : "";
  }).join("");
}

/** 代码块保留原文并提供独立复制反馈，卸载时清理计时器。 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  /** 复制成功后短暂显示反馈。 */
  function resetCopyFeedback() {
    if (!copied) return;
    const timer = window.setTimeout(function reset() { setCopied(false); }, 1500);
    return function cleanup() { window.clearTimeout(timer); };
  }
  useEffect(resetCopyFeedback, [copied]);
  /** 浏览器拒绝剪贴板访问时保留可重试按钮。 */
  async function copyCode() {
    try { await navigator.clipboard.writeText(plainText(children)); setCopied(true); } catch { setCopied(false); }
  }
  return <pre className="relative my-3 overflow-x-auto border-2 border-ink bg-ink p-3 pt-9 text-xs text-ink-on-dark [&>code]:border-0 [&>code]:p-0 [&>code]:text-inherit"><button type="button" onClick={copyCode} aria-label="复制代码" className="absolute right-2 top-2 border border-ink-on-dark px-2 py-1 text-[10px] font-semibold hover:bg-ink-on-dark hover:text-ink">{copied ? "已复制" : "复制"}</button>{children}</pre>;
}

/** 来源图片以紧凑缩略图展示，点击弹窗查看原图；失效时保留可读说明。 */
function KnowledgeImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  if (failed) return <span role="status" className="my-3 block border border-ink/30 p-3 text-sm text-muted">{alt}：预览不可用，资源可能已删除或暂时无法读取。</span>;
  return <>
    <button type="button" aria-label={`查看来源大图：${alt}`} aria-haspopup="dialog" onClick={function openPreview(event) { event.currentTarget.focus(); setPreviewOpen(true); }} className="my-2 inline-flex max-w-full cursor-zoom-in flex-col items-start gap-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      {/* 受控原图不经过 Next 图片代理，避免把私有来源发送到额外服务。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" onError={function previewFailed() { setFailed(true); }} className="block h-auto max-h-40 max-w-[min(10rem,100%)] border-2 border-ink bg-card object-contain" />
      <span className="text-xs text-muted">点击查看大图</span>
    </button>
    {previewOpen && <SourceImageDialog src={src} alt={alt} onClose={function closePreview() { setPreviewOpen(false); }} />}
  </>;
}

/** 使用标准语法解析器，保留受限 URL 策略且不执行原始 HTML。 */
export default function MarkdownRenderer({ content, ragEvidence = false }: Props) {
  const [pendingLink, setPendingLink] = useState<{ url: string; label: string } | null>(null);
  const markdown = useMemo(function prepareContent() { return ragEvidence ? formatRagTables(content) : content; }, [content, ragEvidence]);
  const components = useMemo<Components>(function markdownComponents() { return {
    /** 链接继续使用现有外链确认，不因解析器替换而自动跳转。 */
    a: function ConfirmedLink({ href, children }) {
      const label = plainText(children);
      const bare = /^https?:\/\//i.test(label) && normalizeExternalLink(label) === normalizeExternalLink(href ?? "");
      const target = bare ? trimLinkPunctuation(label.split(/[，。！？；：、（）《》【】“”‘’]/)[0]) : href ?? "";
      const suffix = bare ? label.slice(target.length) : "";
      const url = normalizeExternalLink(target);
      if (!url) return <>{children}</>;
      /** 鼠标和键盘激活都先展示目标确认，并保留关闭后的焦点。 */
      function confirm(event: MouseEvent<HTMLAnchorElement>) {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
        setPendingLink({ url: url!, label: plainText(children) || url! });
      }
      return <><a href={url} target="_blank" rel="noopener noreferrer" aria-haspopup="dialog" title={"打开链接：" + new URL(url).host} onClick={confirm} onAuxClick={function middleClick(event) { if (event.button === 1) confirm(event); }} className="break-words text-accent underline decoration-accent/50 underline-offset-4 transition-colors hover:bg-accent/15 hover:decoration-accent focus-visible:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{bare ? target : children}<span aria-hidden="true" className="ml-0.5 text-[10px]">↗</span></a>{suffix}</>;
    },
    /** 只在 RAG 回答中将受控资源预览解释为图片；其余图片保留说明文本。 */
    img: function SourceImage({ src, alt }) { return ragEvidence && typeof src === "string" && isKnowledgeImage(src) ? <KnowledgeImage key={src} src={src} alt={alt || "来源图片"} /> : <span>{alt || "图片"}</span>; },
    /** 各级标题使用显式 Tailwind 字号，避免依赖未安装的 Typography 插件。 */
    h1: function Heading1({ children }) { return <h1 className="mb-3 mt-5 text-2xl font-bold">{children}</h1>; },
    /** 二级标题使用独立字号与段间距。 */
    h2: function Heading2({ children }) { return <h2 className="mb-2 mt-4 text-xl font-bold">{children}</h2>; },
    /** 三级标题保持次级层次。 */
    h3: function Heading3({ children }) { return <h3 className="mb-2 mt-3 text-lg font-semibold">{children}</h3>; },
    /** 四级标题以正文大号区分。 */
    h4: function Heading4({ children }) { return <h4 className="mb-1 mt-3 text-base font-semibold">{children}</h4>; },
    /** 五级标题采用紧凑粗体。 */
    h5: function Heading5({ children }) { return <h5 className="mb-1 mt-2 text-sm font-bold">{children}</h5>; },
    /** 六级标题保留语义并使用弱化颜色。 */
    h6: function Heading6({ children }) { return <h6 className="mb-1 mt-2 text-sm font-semibold text-muted">{children}</h6>; },
    /** 正文和列表显式设置排版，标准语法树负责嵌套及行内格式。 */
    p: function Paragraph({ children }) { return <p className="mb-2 leading-relaxed">{children}</p>; },
    /** 无序列表恢复 Tailwind reset 移除的项目符号。 */
    ul: function BulletList({ children }) { return <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>; },
    /** 有序列表保留解析器给出的起始序号。 */
    ol: function OrderedList({ children, start }) { return <ol start={start} className="my-2 list-decimal space-y-1 pl-6">{children}</ol>; },
    /** 引用块使用纸本强调边线。 */
    blockquote: function Quote({ children }) { return <blockquote className="my-3 border-l-2 border-accent pl-4 text-muted">{children}</blockquote>; },
    /** 标准分隔线使用项目粗实线。 */
    hr: function Divider() { return <hr className="my-4 border-t-2 border-ink" />; },
    pre: CodeBlock,
    /** 行内代码保持字面内容，代码块由父容器覆盖颜色。 */
    code: function Code({ children, className }) { return <code className={"border border-ink px-1 text-xs text-accent " + (className ?? "")}>{children}</code>; },
    /** 表格横向滚动，不让宽表挤破消息区；表头保留列语义。 */
    table: function Table({ children }) { return <div className="my-3 overflow-x-auto border-2 border-ink bg-card"><table className="w-full text-sm">{children}</table></div>; },
    /** 深色表头提供与数据区的视觉区分。 */
    thead: function TableHead({ children }) { return <thead className="bg-ink text-ink-on-dark">{children}</thead>; },
    /** 行分隔线帮助核对各条记录。 */
    tr: function TableRow({ children }) { return <tr className="border-b border-ink/20">{children}</tr>; },
    /** 列标题向读屏声明对应列。 */
    th: function TableHeader({ children }) { return <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-semibold">{children}</th>; },
    /** 数据单元格按内容换行并顶端对齐。 */
    td: function TableCell({ children }) { return <td className="px-3 py-2 align-top">{children}</td>; },
  }; }, [ragEvidence]);
  /** 标准解析器先过滤危险协议，图片还需命中站内知识路由。 */
  function transformUrl(url: string, key: string) { return key === "src" ? ragEvidence && isKnowledgeImage(url) ? url : "" : defaultUrlTransform(url); }
  return <><div className="prose prose-sm max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={transformUrl}>{markdown}</ReactMarkdown></div>{pendingLink && <ExternalLinkDialog url={pendingLink.url} label={pendingLink.label} onClose={function closeLinkDialog() { setPendingLink(null); }} />}</>;
}
