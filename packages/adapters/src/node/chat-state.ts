/** Chat 应用级存储布局：临时附件与知识库独立于 durable schema 备份，不依赖工作区或 cwd。 */
import { NodeStateError, NodeChatError, toNodeBoundaryError } from "./node-errors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNodeGlobalStateRoot } from "./state-root";

/** 三个数据域仅由受信宿主解析，不能来自浏览器字段。 */
export interface NodeChatStatePaths {
  root: string;
  stateRoot: string;
  attachmentsRoot: string;
  knowledgeRoot: string;
}

/** 解析固定应用级 Chat 根；显式全局根必须是绝对路径。 */
export function resolveNodeChatStatePaths(options: { globalStateRoot?: string } = {}): NodeChatStatePaths {
  try {
    if (options.globalStateRoot !== undefined && !path.isAbsolute(options.globalStateRoot)) throw new NodeChatError("CHAT_STATE_ROOT_INVALID");
    const globalRoot = resolveNodeGlobalStateRoot({ globalStateRoot: options.globalStateRoot, cwd: os.homedir() });
    const root = path.join(globalRoot, "chat");
    return { root, stateRoot: path.join(root, "state"), attachmentsRoot: path.join(root, "attachments"), knowledgeRoot: path.join(root, "knowledge") };
  } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
}

/** 校验根内每一级已有路径均不是链接；允许缺失尾部供后续原子创建。 */
export function assertSafeNodePath(root: string, target: string): void {
  try {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new NodeStateError("STATE_STORAGE_UNSAFE_PATH");
    let current = root;
    for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      try {
        const entry = fs.lstatSync(current);
        if (entry.isSymbolicLink() || (current !== target && !entry.isDirectory())) throw new NodeStateError("STATE_STORAGE_UNSAFE_PATH");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        break;
      }
    }
  } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
}

/** 创建受控目录；调用前后都检查链接，避免递归 mkdir 跟随已存在的链接。 */
export function ensureChatDirectory(root: string, target: string): void {
  try {
    assertSafeNodePath(root, target);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    assertSafeNodePath(root, target);
    if (!fs.lstatSync(target).isDirectory()) throw new NodeStateError("STATE_STORAGE_UNSAFE_PATH");
  } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
}

/** 初始化 Chat durable/临时域；知识根仅在 RAG 被明确装配时创建。 */
export function initializeNodeChatDirectories(paths: NodeChatStatePaths): void {
  ensureChatDirectory(path.dirname(paths.root), paths.root);
  ensureChatDirectory(paths.root, paths.stateRoot);
  ensureChatDirectory(paths.root, paths.attachmentsRoot);
}
