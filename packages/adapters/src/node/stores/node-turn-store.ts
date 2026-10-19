/**
 * Node TurnStore：在显式 stateRoot/turns 下原子保存 Turn 与冻结运行配置。
 */

import fs from "node:fs";
import type { Turn, TurnStore } from "@autopilot-agent/core";
import { atomicReplace, readJsonFile, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 TurnStore。 */
export function createNodeTurnStore(options: NodeStoreOptions): TurnStore {
  const paths = getNodeStatePaths(options.stateRoot);

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.turnsDir, { recursive: true });
  }

  /** 返回指定 Turn 的安全文件路径。 */
  function filePath(turnId: string): string {
    return safeFilePath(paths.turnsDir, turnId, ".json");
  }

  return {
    async get(id: string): Promise<Turn | null> {
      ensureDir();
      return withFileLock(filePath(id), () => readJsonFile<Turn>(filePath(id)));
    },

    async save(turn: Turn): Promise<void> {
      ensureDir();
      await withFileLock(filePath(turn.id), () => {
        atomicReplace(filePath(turn.id), JSON.stringify(turn, null, 2));
      });
    },

    async list(sessionId: string): Promise<Turn[]> {
      ensureDir();
      const turns: Turn[] = [];
      for (const file of fs.readdirSync(paths.turnsDir).filter((entry) => entry.endsWith(".json"))) {
        const turn = readJsonFile<Turn>(filePath(file.slice(0, -5)));
        if (turn?.sessionId === sessionId) turns.push(turn);
      }
      return turns;
    },

    async getLatest(sessionId: string): Promise<Turn | null> {
      const turns = await this.list(sessionId);
      if (turns.length === 0) return null;
      return turns.reduce((latest, turn) => (turn.startedAt > latest.startedAt ? turn : latest));
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      const turns = await this.list(sessionId);
      for (const turn of turns) {
        const target = filePath(turn.id);
        await withFileLock(target, () => {
          if (fs.existsSync(target)) fs.unlinkSync(target);
        });
      }
    },
  };
}
