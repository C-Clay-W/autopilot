/** CLI会话标题：沿Web短文本范式，不增加模型采样，普通界面不以机器ID作标题。 */

/** 从已有用户输入/成功回答得到20字短标题，清除终端控制字符和换行。 */
export function createCliSessionTitle(content: string): string {
  return content.replace(/[\x00-\x1f\x7f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 20) || "Agent 对话";
}

/** 历史空标题与旧机器ID标题使用安全占位；手工标题仅做显示净化。 */
export function getCliSessionDisplayTitle(title: string | undefined, sessionId?: string): string {
  const clean = title?.replace(/[\x00-\x1f\x7f]/gu, " ").trim();
  return !clean || clean === sessionId || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(clean) ? "新对话" : clean;
}
