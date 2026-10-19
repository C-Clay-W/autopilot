/** useWorkControls.ts — 存储配额、Skill catalog/选择、数据库同步与浏览器 preference 的连续逻辑；自原 page.tsx 原样迁入，不含新的业务判断。 */
"use client";

import { useCallback, useState, useEffect } from "react";
import type { RefObject } from "react";
import type { AgentStorageQuotaView } from "../components/StorageQuotaPanel";
import { getStoredToggle } from "../chat-page-helpers";
import type {
  SkillCatalogEntry,
  SelectedSkill,
} from "../chat-page-types";
import type { WebSessionPinnedSkill as SessionPinnedSkill } from "@/lib/runtime-host/web-ui-dto";

interface UseWorkControlsOptions {
  isChat: boolean;
  workspaceId: string;
  canWriteRef: RefObject<boolean>;
  hasWorkspace: boolean;
}

/** 承接原 ChatPageContent 的 storage/Skill/database/preference 逻辑；语句顺序保持不变。 */
export function useWorkControls({ isChat, workspaceId, canWriteRef, hasWorkspace }: UseWorkControlsOptions) {
  const [showSources, setShowSources] = useState(false);
  const [showProcess, setShowProcess] = useState(true);
  const [databaseEnabled, setDatabaseEnabled] = useState(false);
  const [databaseSyncing, setDatabaseSyncing] = useState(false);
  const [databaseSyncMessage, setDatabaseSyncMessage] = useState("");
  const [databaseSyncElapsedSeconds, setDatabaseSyncElapsedSeconds] = useState(0);
  const [storageQuota, setStorageQuota] = useState<AgentStorageQuotaView | undefined>();
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([]);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  /** 当前 Session 的 Skill 选择由 Work 控件持有，History 恢复通过 setter 接回。 */
  const [selectedSkills, setSelectedSkills] = useState<SelectedSkill[]>([]);
  const [pinnedSkills, setPinnedSkills] = useState<SessionPinnedSkill[]>([]);

  /** 加载本机服务端全局 Agent 存储状态；失败不影响正常聊天和已有会话。 */
  useEffect(function loadAgentStorageQuota() {
    if (isChat || !hasWorkspace) return;
    let active = true;
    /** 请求只读存储状态，并在组件仍处于挂载状态时更新 UI。 */
    async function requestAgentStorageQuota(): Promise<void> {
      try {
        const response = await fetch("/api/agent-storage");
        console.log(response);
        if (!response.ok) return;
        const data = await response.json() as AgentStorageQuotaView;
        if (active) setStorageQuota(data);
      } catch { /* 存储状态只是辅助提示，网络失败不阻断聊天。 */ }
    }
    void requestAgentStorageQuota();
    /** 卸载后忽略异步响应，避免切换页面时写入过期状态。 */
    return function ignoreAgentStorageQuotaResponse() {
      active = false;
    };
  }, [isChat, hasWorkspace, workspaceId]);

  /** 读取只含元数据的 Skill catalog；正文仍仅在服务端收到显式选择后加载。 */
  useEffect(function loadSkillCatalog() {
    if (isChat || !hasWorkspace) return;
    let active = true;
    async function requestSkillCatalog(): Promise<void> {
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`);
        console.log(response);
        if (!response.ok) return;
        const payload = await response.json() as { skills?: SkillCatalogEntry[] };
        if (active) setSkillCatalog(payload.skills ?? []);
      } catch { /* Skill 选择器不可用不阻断普通聊天。 */ }
    }
    void requestSkillCatalog();
    return function ignoreSkillCatalogResponse() { active = false; };
  }, [isChat, hasWorkspace, workspaceId]);

  /** 接收配额面板保存后的服务端快照，使顶部预警无需等待下一次轮询。 */
  function updateStorageQuota(quota: AgentStorageQuotaView): void {
    setStorageQuota(quota);
  }

  useEffect(() => {
    if (preferencesLoaded) window.localStorage.setItem("autopilot.chat.show-sources", String(showSources));
  }, [showSources, preferencesLoaded]);

  useEffect(() => {
    if (preferencesLoaded) window.localStorage.setItem("autopilot.chat.show-process", String(showProcess));
  }, [showProcess, preferencesLoaded]);

  useEffect(() => {
    if (preferencesLoaded) window.localStorage.setItem("autopilot.chat.database-enabled", String(databaseEnabled));
  }, [databaseEnabled, preferencesLoaded]);

  useEffect(() => {
    if (isChat) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 客户端挂载后一次性恢复 localStorage 偏好，模式自原 page.tsx 原样迁入。
    setShowSources(getStoredToggle("autopilot.chat.show-sources", true));
    setShowProcess(getStoredToggle("autopilot.chat.show-process", false));
    setDatabaseEnabled(getStoredToggle("autopilot.chat.database-enabled", false));
    setPreferencesLoaded(true);
  }, [isChat]);

  /** 同步接口未提供表级进度时，仅展示真实等待时长和活动状态，不伪造完成百分比。 */
  useEffect(function updateDatabaseSyncElapsed() {
    if (!databaseSyncing) return;
    const timer = window.setInterval(() => {
      setDatabaseSyncElapsedSeconds((seconds) => seconds + 1);
    }, 1000);
    return function clearDatabaseSyncElapsedTimer() {
      window.clearInterval(timer);
    };
  }, [databaseSyncing]);

  /** 仅开发环境手动生成服务端已配置数据源的本地快照，浏览器不接触连接信息。 */
  async function syncDatabase(): Promise<void> {
    if (isChat || !canWriteRef.current) return;
    if (databaseSyncing) return;
    setDatabaseSyncing(true);
    setDatabaseSyncElapsedSeconds(0);
    setDatabaseSyncMessage("正在同步数据库快照…");
    try {
      const res = await fetch("/api/mysql-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      console.log(res);
      const data = await res.json() as { tableCount?: number; vectorCount?: number; error?: string };
      if (!res.ok) throw new Error(data.error || "数据库同步失败");
      setDatabaseEnabled(true);
      setDatabaseSyncMessage(`已同步 ${data.tableCount ?? 0} 张表、${data.vectorCount ?? 0} 条索引`);
    } catch (error) {
      setDatabaseSyncMessage(error instanceof Error ? error.message : "数据库同步失败");
    } finally {
      setDatabaseSyncing(false);
    }
  }

  /** 返回 catalog 中的显示名称；Skill 刷新期间保留限定名作为稳定回退。 */
  const getSkillDisplayName = useCallback(function getSkillDisplayName(skillRef: string): string {
    const skill = skillCatalog.find((item) => item.qualifiedName === skillRef);
    return skill?.displayName || skill?.name || skillRef;
  }, [skillCatalog]);

  /** 选择或取消本轮 Skill；固定项取消选择时同时转为待取消固定。 */
  function toggleSelectedSkill(skillRef: string): void {
    const existing = selectedSkills.find((skill) => skill.skillRef === skillRef);
    if (!existing) {
      setSelectedSkills((current) => [...current, { skillRef }]);
      return;
    }
    if (existing.pinned) {
      setSelectedSkills((current) => current.map((skill) => skill.skillRef === skillRef ? { ...skill, pinned: false } : skill));
      setPinnedSkills((current) => current.filter((skill) => skill.skillRef !== skillRef));
      return;
    }
    setSelectedSkills((current) => current.filter((skill) => skill.skillRef !== skillRef));
  }

  /** 切换跨 Turn 固定状态；取消固定仍会让该 Skill 在当前 Turn 生效一次。 */
  function togglePinnedSkill(skillRef: string): void {
    const isPinned = selectedSkills.some((skill) => skill.skillRef === skillRef && skill.pinned);
    if (isPinned) {
      setSelectedSkills((current) => current.map((skill) => skill.skillRef === skillRef ? { ...skill, pinned: false } : skill));
      setPinnedSkills((current) => current.filter((skill) => skill.skillRef !== skillRef));
      return;
    }
    const catalogSkill = skillCatalog.find((skill) => skill.qualifiedName === skillRef);
    setSelectedSkills((current) => current.some((skill) => skill.skillRef === skillRef) ? current.map((skill) => skill.skillRef === skillRef ? { ...skill, pinned: true } : skill) : [...current, { skillRef, pinned: true }]);
    if (catalogSkill) setPinnedSkills((current) => current.some((skill) => skill.skillRef === skillRef) ? current : [...current, { skillRef, skillId: catalogSkill.skillId, contentHash: "", pinnedAt: Date.now() }]);
  }

  return {
    showSources, setShowSources,
    showProcess, setShowProcess,
    databaseEnabled, setDatabaseEnabled,
    databaseSyncing,
    databaseSyncMessage,
    databaseSyncElapsedSeconds,
    storageQuota,
    updateStorageQuota,
    skillCatalog,
    selectedSkills, setSelectedSkills,
    pinnedSkills, setPinnedSkills,
    getSkillDisplayName,
    toggleSelectedSkill,
    togglePinnedSkill,
    syncDatabase,
  };
}
