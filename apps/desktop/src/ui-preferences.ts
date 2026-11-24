// Desktop 外观与通知有限偏好，复用布局宿主持久化，不保存临时通知事实。
export type ThemeMode = "light" | "dark" | "system";
export type NotificationPosition = "center" | "bottom-right";
export interface UiPreferences { theme: ThemeMode; onboardingComplete: boolean; notificationPosition: NotificationPosition; confirmationPosition: NotificationPosition; duration: 3 | 5 | 10; doNotDisturb: boolean; pauseOnHover: boolean }
/** 新安装默认自适应，存在历史布局则保留暗色并跳过引导。 */
export function defaultUiPreferences(existing = false): UiPreferences { return { theme: existing ? "dark" : "system", onboardingComplete: existing, notificationPosition: "bottom-right", confirmationPosition: "center", duration: 5, doNotDisturb: true, pauseOnHover: true }; }
/** 同一白名单同时校验磁盘偏好与 IPC 完整提交，拒绝额外字段。 */
export function isUiPreferences(value: unknown): value is UiPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).length === 7 && Object.keys(data).every(function known(key) { return Object.hasOwn(defaultUiPreferences(), key); }) && ["light", "dark", "system"].includes(data.theme as string) && typeof data.onboardingComplete === "boolean" && ["center", "bottom-right"].includes(data.notificationPosition as string) && ["center", "bottom-right"].includes(data.confirmationPosition as string) && [3, 5, 10].includes(data.duration as number) && typeof data.doNotDisturb === "boolean" && typeof data.pauseOnHover === "boolean";
}
/** 系统事件只改变自适应结果，手动模式始终保持用户选择。 */
export function resolvedTheme(mode: ThemeMode, systemDark: boolean): "light" | "dark" { return mode === "system" ? systemDark ? "dark" : "light" : mode; }
