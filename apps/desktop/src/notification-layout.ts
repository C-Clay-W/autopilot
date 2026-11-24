// 通知分组与宿主矩形使用同一位置模型，同位置共享原到达顺序。
import type { DesktopNotification } from "./desktop-notifications";
import type { NotificationPosition, UiPreferences } from "./ui-preferences";
/** 生命周期与位置独立，审批仍归通知组。 */
export function notificationPosition(item: DesktopNotification, ui: UiPreferences): NotificationPosition { return item.group === "confirmation" ? ui.confirmationPosition : ui.notificationPosition; }
/** 同位置不另开叠层，保持已有数组顺序。 */
export function notificationsAt(items: DesktopNotification[], ui: UiPreferences, position: NotificationPosition): DesktopNotification[] { return items.filter(function belongs(item) { return notificationPosition(item, ui) === position; }); }
/** 固定两种位置仅在主窗口内容区域内，父窗口移动与缩放重新计算。 */
export function notificationBounds(bounds: { x: number; y: number; width: number; height: number }, requestedHeight: number, position: NotificationPosition) {
  const width = Math.max(1, Math.min(400, bounds.width - 16));
  const height = Math.max(1, Math.min(requestedHeight, bounds.height - 16));
  return { x: Math.round(bounds.x + (position === "center" ? (bounds.width - width) / 2 : bounds.width - width - 8)), y: Math.round(bounds.y + (position === "center" ? (bounds.height - height) / 2 : bounds.height - height - 8)), width, height };
}
