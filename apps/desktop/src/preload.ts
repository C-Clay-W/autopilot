// 隔离桥接层只暴露命名方法，不向页面开放 ipcRenderer。
import { contextBridge, ipcRenderer } from "electron";
import { BOOTSTRAP_CHANNEL, PARALLEL_CHANNEL, type DesktopBridge, type WorkspacePage } from "./contract";
import type { Workspace } from "./workspace";
import { BROWSER_CHANNEL } from "./browser-contract";
import { ORCHESTRATION_CHANNEL, ORCHESTRATION_CHANGED } from "./orchestration-contract";

/** 串行收齐同一宿主版本后才发布给 renderer，保留原公开桥接签名。 */
async function getWorkspace(): Promise<Workspace> {
  let page: WorkspacePage = await ipcRenderer.invoke(PARALLEL_CHANNEL, "workspace");
  const id = page.snapshotId;
  const revision = page.revision;
  const chunks: string[] = [];
  let offset = 0;
  while (true) {
    if (page.snapshotId !== id || page.revision !== revision || page.offset !== offset || !page.chunk.length) throw new Error("DESKTOP_SNAPSHOT_INVALID");
    chunks.push(page.chunk); offset += page.chunk.length;
    if (page.final) break;
    page = await ipcRenderer.invoke(PARALLEL_CHANNEL, "workspace", id, offset);
  }
  return JSON.parse(chunks.join("")) as Workspace;
}

const bridge: DesktopBridge = {
  orchestration: {
    /** 固定工作区终端只开放附着与输入输出，运行身份由主进程决定。 */
    terminal: function terminal(...args) { return ipcRenderer.invoke(ORCHESTRATION_CHANNEL, "terminal", ...args); },
    /** 只读跨模式总台，刷新不会恢复执行。 */
    snapshot: function snapshot(reconcile = true, sessionIds) { return ipcRenderer.invoke(ORCHESTRATION_CHANNEL, "snapshot", reconcile, sessionIds); },
    /** 通知只提示刷新；禁止把 IPC event 或未验证的数据交给 renderer。 */
    onChanged: function onChanged(listener) {
      function changed(_event: Electron.IpcRendererEvent, sessionId?: string) { listener(sessionId); }
      ipcRenderer.on(ORCHESTRATION_CHANGED, changed);
      return function dispose() { ipcRenderer.removeListener(ORCHESTRATION_CHANGED, changed); };
    },
    /** 固定业务动作由 main 校验并绑定人类身份。 */
    command: function command(value) { return ipcRenderer.invoke(ORCHESTRATION_CHANNEL, "command", value); },
  },
  /** 首屏主题或固定错误文案准备好后，请求宿主展示所属主窗口。 */
  showMainWindow: function showMainWindow() { return ipcRenderer.invoke(PARALLEL_CHANNEL, "showMainWindow"); },
  getAppearance: function getAppearance() { return ipcRenderer.invoke(PARALLEL_CHANNEL, "appearance"); },
  /** 单一宿主来源同步主题和应用焦点，卸载释放监听。 */
  onAppearance: function onAppearance(listener) {
    function update(_event: Electron.IpcRendererEvent, value: { theme: "light" | "dark"; focused: boolean }) { listener(value); }
    ipcRenderer.on("desktop:appearance", update);
    return function dispose() { ipcRenderer.removeListener("desktop:appearance", update); };
  },
  browser: {
    /** 只读检测固定驱动与技能资源。 */
    integration: function integration() { return ipcRenderer.invoke(BROWSER_CHANNEL, "integration"); },
    /** 用户显式安装固定技能，不接受任意路径或内容。 */
    installSkill: function installSkill(id) { return ipcRenderer.invoke(BROWSER_CHANNEL, "installSkill", id); },
    /** 浏览器快照不包含连接凭据。 */
    snapshot: function snapshot(workspaceId) { return ipcRenderer.invoke(BROWSER_CHANNEL, "snapshot", workspaceId); },
    /** 固定手动动作由宿主校验。 */
    command: function command(value, workspaceId) { return ipcRenderer.invoke(BROWSER_CHANNEL, "command", value, workspaceId); },
    /** 仅提交原生网页的可见内容矩形。 */
    bounds: function bounds(value, workspaceId) { return ipcRenderer.invoke(BROWSER_CHANNEL, "bounds", value, workspaceId); },
    /** 读取持久偏好，不返回网页存储。 */
    settings: function settings() { return ipcRenderer.invoke(BROWSER_CHANNEL, "settings"); },
    /** 固定偏好由主进程校验并串行保存。 */
    preferences: function preferences(value) { return ipcRenderer.invoke(BROWSER_CHANNEL, "preferences", value); },
    /** 清除历史保留下载文件。 */
    clearHistory: function clearHistory() { return ipcRenderer.invoke(BROWSER_CHANNEL, "clearHistory"); },
    /** 保存目录使用主进程系统选择器。 */
    chooseDownloadDirectory: function chooseDownloadDirectory() { return ipcRenderer.invoke(BROWSER_CHANNEL, "chooseDownloadDirectory"); },
    /** 审批只能回答宿主当前请求，不能提交新动作或调用身份。 */
    answerApproval: function answerApproval(id, choice) { return ipcRenderer.invoke(BROWSER_CHANNEL, "answerApproval", id, choice); },
  },
  /** 读取主进程生成的安全启动摘要。 */
  getBootstrap: function getBootstrap() { return ipcRenderer.invoke(BOOTSTRAP_CHANNEL); },
  /** 获取宿主权威布局，刷新时不触发创建。 */
  getWorkspace,
  /** 检测固定的四种第三方 CLI，只返回可用性。 */
  getAgentInstallations: function getAgentInstallations() { return ipcRenderer.invoke(PARALLEL_CHANNEL, "agentInstallations"); },
  /** 在当前窗口打开受控目录选择器。 */
  pickDirectory: function pickDirectory() { return ipcRenderer.invoke(PARALLEL_CHANNEL, "pick"); },
  /** 发送白名单工作台动作。 */
  command: async function command(value) { await ipcRenderer.invoke(PARALLEL_CHANNEL, "command", value); return getWorkspace(); },
  /** 独立于命令队列读取当前宿主请求及关闭阶段。 */
  getCloseConfirmation: function getCloseConfirmation() { return ipcRenderer.invoke(PARALLEL_CHANNEL, "closeConfirmation"); },
  /** 只回答当前宿主请求，不接受 renderer 指定关闭范围。 */
  answerCloseConfirmation: function answerCloseConfirmation(id, confirmed) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "answerClose", id, confirmed); },
  /** 仅调整所属主窗口右下角通知浮层的高度。 */
  setNotificationHeight: function setNotificationHeight(position, height) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "notificationHeight", position, height); },
  /** 请求主进程写入终端选区或编排模板，不向页面开放剪贴板读取。 */
  copyTerminalText: function copyTerminalText(text) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "copyTerminalText", text); },
  /** 按游标拉取有限输出，隐藏终端也持续消费。 */
  readTerminal: function readTerminal(id, generation, after) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "read", id, generation, after); },
  /** 发送目标终端输入。 */
  writeTerminal: function writeTerminal(id, generation, data) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "write", id, generation, data); },
  /** 更新非零终端尺寸。 */
  resizeTerminal: function resizeTerminal(id, generation, cols, rows) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "resize", id, generation, cols, rows); },
  /** 仅请求 CLI 展示层预排版，不发送终端输入或业务 Prompt。 */
  prepareTerminalResize: function prepareTerminalResize(id, generation, cols, rows) { return ipcRenderer.invoke(PARALLEL_CHANNEL, "prepareResize", id, generation, cols, rows); },
};

contextBridge.exposeInMainWorld("autopilotDesktop", Object.freeze(bridge));
