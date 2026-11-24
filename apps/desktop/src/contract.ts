// 桌面桥接只公开工作台与受管终端的固定能力，禁止任意进程或文件调用。
import type { AgentType, Workspace, WorkspaceCommand } from "./workspace";
import type { BrowserBridge } from "./browser-contract";
export const BOOTSTRAP_CHANNEL = "desktop:bootstrap";
export const PARALLEL_CHANNEL = "desktop:parallel";
export interface CloseConfirmation { id: string; message: string; detail: string; confirmLabel?: string; phase: "confirm" | "closing" }
export interface WorkspacePage { snapshotId: string; revision: number; offset: number; chunk: string; final: boolean }
export type AgentInstallation = "available" | "missing" | "error";
export type AgentInstallations = Record<Exclude<AgentType, "ap">, AgentInstallation>;

export interface DesktopBootstrap {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  checkedAt: string;
  settingsDiagnosticCount: number;
  presentationItemCount: number;
}

export interface DesktopBridge {
  orchestration: import("./orchestration-contract").OrchestrationBridge;
  browser: BrowserBridge;
  showMainWindow(): Promise<void>;
  getAppearance(): Promise<{ theme: "light" | "dark"; focused: boolean }>;
  onAppearance(listener: (appearance: { theme: "light" | "dark"; focused: boolean }) => void): () => void;
  getBootstrap(): Promise<DesktopBootstrap>;
  getWorkspace(): Promise<Workspace>;
  getAgentInstallations(): Promise<AgentInstallations>;
  pickDirectory(): Promise<{ path: string; name: string } | null>;
  command(command: WorkspaceCommand): Promise<Workspace>;
  getCloseConfirmation(): Promise<CloseConfirmation | null>;
  answerCloseConfirmation(id: string, confirmed: boolean): Promise<boolean>;
  setNotificationHeight(position: "center" | "bottom-right", height: number): Promise<boolean>;
  copyTerminalText(text: string): Promise<void>;
  readTerminal(id: string, generation: number, after: number): Promise<TerminalOutput>;
  writeTerminal(id: string, generation: number, data: string): Promise<void>;
  resizeTerminal(id: string, generation: number, cols: number, rows: number): Promise<void>;
  prepareTerminalResize(id: string, generation: number, cols: number, rows: number): Promise<string | null>;
}

export interface TerminalOutput { data: string; cursor: number; gap: boolean }
