/** ChatImagePreview.tsx — 会话附件与来源图片的全屏预览弹层；纯展示组件，关闭动作由父级注入。 */
"use client";

import Image from "next/image";
import type { Dispatch, SetStateAction } from "react";

interface ChatImagePreviewProps {
  selectedImage: { url: string; alt: string } | null;
  setSelectedImage: Dispatch<SetStateAction<{ url: string; alt: string } | null>>;
}

/** 渲染图片预览弹层；无选中图片时不输出任何 DOM。 */
export default function ChatImagePreview({ selectedImage, setSelectedImage }: ChatImagePreviewProps) {
  if (!selectedImage) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="来源图片预览"
      onMouseDown={() => setSelectedImage(null)}
    >
      <div
        className="max-h-full max-w-5xl border-[3px] border-ink bg-card p-3"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-4 border-b-2 border-ink pb-2 text-xs">
          <span className="text-accent">来源图片预览</span>
          <button
            type="button"
            onClick={() => setSelectedImage(null)}
            className="border-2 border-ink px-2 py-1 hover:bg-ink hover:text-ink-on-dark"
          >
            关闭
          </button>
        </div>
        <Image src={selectedImage.url} alt={selectedImage.alt} width={1200} height={900} className="max-h-[75vh] max-w-full object-contain" />
      </div>
    </div>
  );
}
