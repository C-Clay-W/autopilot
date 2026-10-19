/**
 * TUI @文件提及的索引预热：挂载后调用一次 Core `listWorkspaceFiles`，模块级缓存供整个会话复用。
 * 空查询候选由「工作区一层目录（尾随 /）+ 全部文件」合并稳定排序构成；失败静默降级为空候选。
 */

import { useEffect, useState } from "react";
import { listWorkspaceFiles } from "@autopilot-agent/core";

/** useFileMentionIndex 的返回契约；ready 为 false 时 @ 菜单不激活。 */
export interface FileMentionIndex {
  /** 目录（尾随 /）与文件的稳定排序候选池。 */
  entries: string[];
  /** 索引是否已就绪（成功或失败终态）。 */
  ready: boolean;
}

let cachedMentionEntries: string[] | undefined;
let cachedMentionLoad: Promise<string[]> | undefined;

/** 清空模块级 @ 索引缓存；仅供测试在用例间隔离。 */
export function resetFileMentionIndexCache(): void {
  cachedMentionEntries = undefined;
  cachedMentionLoad = undefined;
}

/** 从文件列表推导空查询候选：一层目录（尾随 /）+ 全部文件，localeCompare 稳定排序。 */
function buildMentionEntries(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const slashIndex = file.indexOf("/");
    if (slashIndex > 0) directories.add(`${file.slice(0, slashIndex)}/`);
  }
  return [...directories, ...files].sort(function compareEntries(left, right) {
    return left.localeCompare(right);
  });
}

/** 挂载后预热 @ 文件索引；workspaceRoot 缺失或 Core 枚举失败时静默降级为空候选，不影响普通输入。 */
export function useFileMentionIndex(workspaceRoot: string | undefined): FileMentionIndex {
  const [entries, setEntries] = useState<string[]>(function readCachedEntries() {
    return cachedMentionEntries ?? [];
  });
  const [ready, setReady] = useState(function readCachedReady() {
    return cachedMentionEntries !== undefined;
  });

  useEffect(function preloadMentionIndex() {
    if (!workspaceRoot || cachedMentionEntries !== undefined) return;
    if (!cachedMentionLoad) {
      cachedMentionLoad = listWorkspaceFiles({ workspaceRoot })
        .then(function collect(result) {
          return buildMentionEntries(result.files);
        })
        .catch(function degradeOnFailure() {
          return [];
        });
    }
    let cancelled = false;
    void cachedMentionLoad.then(function applyLoaded(loaded) {
      if (cancelled) return;
      cachedMentionEntries = loaded;
      setEntries(loaded);
      setReady(true);
    });
    return function cancelPreload() {
      cancelled = true;
    };
  }, [workspaceRoot]);

  return { entries, ready };
}
