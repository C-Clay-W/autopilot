/**
 * node/thread-handoff.ts — 显式任务交接文档的 Node 写入实现
 *
 * 只写受信工作区内固定的 `.autopilot/thread-passdown-<handoffId>.md`：
 * 路径、文件名由 Core 派生，模型与浏览器不能指定；同 ID 同内容幂等，不同内容冲突。
 * 本模块不解释交接语义，也不改写已接受的消息。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ThreadHandoffDocument, ThreadHandoffDocumentInput, ThreadHandoffWriter } from "@autopilot-agent/core";
import { atomicReplace, withAsyncFileLock } from "./file-utils";

/** 交接目录与文件名固定契约；不读取任何用户可配置目录。 */
const HANDOFF_DIRECTORY = ".autopilot";

/** 宿主写入交接文件的装配参数。 */
export interface CreateNodeThreadHandoffWriterOptions {
  /** 受信 canonical 工作区根；所有交接文件都限制在此目录内。 */
  workspaceRoot: string;
}

/** 判断候选路径是否仍位于根目录内；不依赖字符串前缀，避免同前缀目录逃逸。 */
function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("THREAD_HANDOFF_WRITE_FAILED");
  }
}

/** 计算文件内容的稳定校验和，供目标会话回读时对比。 */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 创建 Node 交接写入器；构造不写磁盘，失败只在调用时抛出。 */
export function createNodeThreadHandoffWriter(options: CreateNodeThreadHandoffWriterOptions): ThreadHandoffWriter {
  const workspaceRoot = path.resolve(options.workspaceRoot);

  /** 把受信 handoffId 解析为固定目录下的固定文件名，并拒绝符号链接越界。 */
  function resolveTarget(handoffId: string): { directory: string; filePath: string } {
    if (!/^[0-9a-f]{16,64}$/.test(handoffId)) throw new Error("THREAD_HANDOFF_WRITE_FAILED");
    const realRoot = fs.realpathSync(workspaceRoot);
    const directory = path.resolve(realRoot, HANDOFF_DIRECTORY);
    assertWithinRoot(realRoot, directory);
    const filePath = path.join(directory, `thread-passdown-${handoffId}.md`);
    assertWithinRoot(realRoot, filePath);
    return { directory, filePath };
  }

  /**
   * 写入或复用同一份交接文档：先按同 ID 加锁，再比较已有内容。
   * 已存在且内容一致时直接返回同一引用，不重写文件。
   */
  async function write(input: ThreadHandoffDocumentInput): Promise<ThreadHandoffDocument> {
    const { directory, filePath } = resolveTarget(input.handoffId);
    const content = `# Handoff：${input.title}\n\n${input.markdown}\n`;
    // 目录已存在时必须仍是工作区内目录；junction/symlink 指向外部时拒绝写入。
    fs.mkdirSync(directory, { recursive: true });
    const realDirectory = fs.realpathSync(directory);
    assertWithinRoot(fs.realpathSync(workspaceRoot), realDirectory);
    await withAsyncFileLock(filePath, function writeLocked() {
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, "utf8");
        if (existing !== content) throw new Error("THREAD_HANDOFF_CONFLICT");
        return;
      }
      atomicReplace(filePath, content);
    });
    const written = fs.readFileSync(filePath, "utf8");
    if (written !== content) throw new Error("THREAD_HANDOFF_CONFLICT");
    return {
      handoffId: input.handoffId,
      relativePath: `${HANDOFF_DIRECTORY}/thread-passdown-${input.handoffId}.md`,
      sha256: sha256(content),
    };
  }

  return { write };
}
