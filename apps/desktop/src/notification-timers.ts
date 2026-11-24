// 普通通知倒计时仅在宿主确认实际展示后创建，状态独立于 Portal 和卡片更新。
import { notificationSnapshot, removeNotification } from "./desktop-notifications";
interface Countdown { remaining: number; started?: number; timer?: ReturnType<typeof setTimeout>; hovered: boolean; focused: boolean }
const countdowns = new Map<string, Countdown>();
let pauseEnabled = true;
/** 重排计时前扣除已经消耗的时间，暂停和设置切换不重置余额。 */
function schedule(id: string, countdown: Countdown): void {
  if (countdown.timer !== undefined) clearTimeout(countdown.timer);
  if (countdown.started !== undefined) countdown.remaining = Math.max(0, countdown.remaining - (Date.now() - countdown.started));
  countdown.started = undefined; countdown.timer = undefined;
  if (pauseEnabled && (countdown.hovered || countdown.focused)) return;
  countdown.started = Date.now();
  countdown.timer = setTimeout(function expire() { removeNotification(id); }, countdown.remaining);
}
/** 尚未展示的队列不计时，同一卡片更新或换位置沿用首次时长。 */
export function displayNotification(id: string, duration: 3 | 5 | 10): void {
  const item = notificationSnapshot().find(function same(item) { return item.id === id; });
  if (!item || item.lifecycle !== "timed" || countdowns.has(id)) return;
  const countdown = { remaining: duration * 1000, hovered: false, focused: false };
  countdowns.set(id, countdown); schedule(id, countdown);
}
/** 鼠标和键盘焦点独立记录，两者都离开才恢复。 */
export function notificationInteraction(id: string, kind: "hovered" | "focused", active: boolean): void {
  const countdown = countdowns.get(id); if (!countdown || countdown[kind] === active) return;
  countdown[kind] = active; schedule(id, countdown);
}
/** 关闭暂停时立即按余额运行，重新开启时尊重当前交互。 */
export function setNotificationPause(enabled: boolean): void {
  if (pauseEnabled === enabled) return; pauseEnabled = enabled;
  for (const [id, countdown] of countdowns) schedule(id, countdown);
}
/** 删除卡片时同步清理唯一计时器，迟到展示回执不能复活卡片。 */
export function clearNotificationTimer(id: string): void {
  const countdown = countdowns.get(id); if (countdown?.timer !== undefined) clearTimeout(countdown.timer); countdowns.delete(id);
}
/** 工作台卸载释放全部计时器，不留页面监听。 */
export function disposeNotificationTimers(): void { for (const id of countdowns.keys()) clearNotificationTimer(id); }
