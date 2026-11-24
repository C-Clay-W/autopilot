// 页面占用与单步执行独立：命令结束不释放整回合占用，取消未确认前不能交接。
export class BrowserOccupancy {
  private pages = new Map<string, { caller: string; turn: string; running: boolean; paused: boolean }>();
  /** 同页并发直接失败，调用方没有等待队列或自动接管。 */
  enter(pageId: string, caller: string, turn: string): void {
    const old = this.pages.get(pageId);
    if (old && (old.running || old.paused || old.caller !== caller || old.turn !== turn)) throw new Error("有其他智能体正在操控，请等待后再试");
    this.pages.set(pageId, { caller, turn, running: true, paused: false });
  }
  /** 结束单步保留占用，失败时暂停等待明确接管或关闭。 */
  settle(pageId: string, uncertain = false): void { const state = this.pages.get(pageId); if (state) { state.running = false; state.paused ||= uncertain; } }
  /** 在途动作未确认停止不能释放，防止旧动作与新调用重叠。 */
  release(pageId: string, caller?: string, turn?: string): boolean {
    const state = this.pages.get(pageId);
    if (!state) return true;
    if (state.running || caller !== undefined && (state.caller !== caller || state.turn !== turn)) return false;
    return this.pages.delete(pageId);
  }
  /** 只暴露占用者，不把回合凭据带入 renderer。 */
  owner(pageId: string): string | undefined { return this.pages.get(pageId)?.caller; }
  /** 取消只匹配准确回合，旧终态不能中断同调用者的新回合。 */
  matches(pageId: string, caller: string, turn: string): boolean { const state = this.pages.get(pageId); return state?.caller === caller && state.turn === turn; }
}
