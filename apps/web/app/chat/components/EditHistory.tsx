/**
 * 可折叠的 edit_file diff 面板：默认折叠，展开后展示本轮所有编辑文件的 unified diff。
 * 遵守 agent/Design.md token 体系。
 */
"use client";

import { useState } from "react";

export interface EditDiffRecord {
  callId: string;
  filePath: string;
  replacements: number;
  diff: string;
}

interface EditHistoryProps {
  editDiffs: EditDiffRecord[];
}

/** 按文件路径合并重复 edit_file 结果，兼容历史会话中已逐调用持久化的记录。 */
function groupEditDiffs(editDiffs: EditDiffRecord[]): EditDiffRecord[] {
  const grouped = new Map<string, EditDiffRecord>();
  for (const record of editDiffs) {
    const existing = grouped.get(record.filePath);
    grouped.set(record.filePath, existing ? { ...existing, callId: record.callId, replacements: existing.replacements + record.replacements, diff: `${existing.diff}\n${record.diff}` } : record);
  }
  return [...grouped.values()];
}

/** 按行着色 unified diff；+ → accent（新增），- → muted（删除），context → ink */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="mt-1 mb-2 max-h-40 overflow-y-auto overflow-x-auto
      border-l-2 border-ink/20 bg-ink/5 px-2 py-1
      text-[10px] leading-relaxed whitespace-pre-wrap">
      {diff.split("\n").map((line, i) => {
        const prefix = line.charAt(0);
        let className = "text-ink";
        if (prefix === "+") className = "text-accent";
        else if (prefix === "-") className = "text-muted";
        return <span key={i} className={className}>{line}{"\n"}</span>;
      })}
    </pre>
  );
}

export default function EditHistory({ editDiffs }: EditHistoryProps) {
  const [open, setOpen] = useState(false);
  const groupedDiffs = groupEditDiffs(editDiffs);

  if (!groupedDiffs.length) return null;

  return (
    <div className="mt-3 border-2 border-ink bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold hover:bg-ink/10"
      >
        <span className="text-accent text-[1.3em]">{open ? "▾" : "▸"}</span>
        <span className="text-ink font-semibold">
          编辑了 {groupedDiffs.length} 个文件{!open && " · 展开"}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink/20 px-3 py-2 space-y-3">
          {groupedDiffs.map((record) => (
            <div key={record.callId}>
              <p className="text-xs text-ink">
                {record.filePath}
                <span className="text-muted"> ({record.replacements} change{record.replacements !== 1 ? "s" : ""})</span>
              </p>
              <DiffBlock diff={record.diff} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
