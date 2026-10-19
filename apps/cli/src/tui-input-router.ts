/** TUI 原始输入分流器；仅解析 SGR 鼠标报文，并完整保留普通键盘字节顺序。 */

const SGR_MOUSE_PREFIX = "\u001b[<";
const X10_MOUSE_PREFIX = "\u001b[M";
const DEFAULT_SGR_BUFFER_LIMIT = 256;

/** 已归一化的 SGR 鼠标报文。 */
export interface TuiSgrMouseEvent {
  code: number;
  column: number;
  row: number;
  released: boolean;
  kind: "wheel_up" | "wheel_down" | "button" | "drag" | "move";
}

/** 一次输入分流的无副作用结果。 */
export interface TuiInputRouterResult {
  passthrough: string;
  mouseEvents: TuiSgrMouseEvent[];
  diagnostics: Array<"invalid_sgr_mouse" | "sgr_mouse_overflow">;
}

/** 提供跨 chunk 缓冲的原始输入分流器。 */
export interface TuiInputRouter {
  push(chunk: string): TuiInputRouterResult;
  finish(): TuiInputRouterResult;
}

/** 根据 SGR 按钮编码归类鼠标行为，供上层状态机消费。 */
export function classifyTuiSgrMouseEvent(code: number): TuiSgrMouseEvent["kind"] {
  // SGR 会把 Shift/Alt/Ctrl 叠加到按钮编码；滚轮方向仍由最低位决定。
  // 不能只识别 64/65，否则按住修饰键或部分 Windows Terminal 报文会被误作普通点击。
  if ((code & 64) === 64) return (code & 1) === 0 ? "wheel_up" : "wheel_down";
  if ((code & 32) === 32) return (code & 3) === 3 ? "move" : "drag";
  return "button";
}

/** 创建有界的输入分流器，避免残缺鼠标控制序列无限累积。 */
export function createTuiInputRouter(bufferLimit = DEFAULT_SGR_BUFFER_LIMIT): TuiInputRouter {
  const limit = Math.max(1, bufferLimit);
  let bufferedMousePrefix = "";

  /** 构造统一的结果对象，避免调用方猜测未解析数据。 */
  function createResult(passthrough = "", mouseEvents: TuiSgrMouseEvent[] = [], diagnostics: TuiInputRouterResult["diagnostics"] = []): TuiInputRouterResult {
    return { passthrough, mouseEvents, diagnostics };
  }

  /** 解析一个完整 SGR 鼠标报文；格式不合法时返回 undefined。 */
  function parseMouseSequence(sequence: string): TuiSgrMouseEvent | undefined {
    const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(sequence);
    if (!match) return undefined;
    const code = Number(match[1]);
    return {
      code,
      column: Number(match[2]),
      row: Number(match[3]),
      released: match[4] === "m",
      kind: classifyTuiSgrMouseEvent(code),
    };
  }

  /** 解析 X10 三字节鼠标报文；部分终端忽略 1006 时仍会以该格式回传滚轮和拖拽。 */
  function parseX10MouseSequence(sequence: string): TuiSgrMouseEvent | undefined {
    if (sequence.length !== 6 || !sequence.startsWith(X10_MOUSE_PREFIX)) return undefined;
    const code = sequence.charCodeAt(3) - 32;
    const column = sequence.charCodeAt(4) - 32;
    const row = sequence.charCodeAt(5) - 32;
    if (code < 0 || column < 1 || row < 1) return undefined;
    return {
      code,
      column,
      row,
      released: code === 3,
      kind: classifyTuiSgrMouseEvent(code),
    };
  }

  /** 处理一个输入 chunk，同时只缓存确认属于 SGR 鼠标前缀的残缺序列。 */
  function push(chunk: string): TuiInputRouterResult {
    let source = bufferedMousePrefix + chunk;
    bufferedMousePrefix = "";
    let passthrough = "";
    const mouseEvents: TuiSgrMouseEvent[] = [];
    const diagnostics: TuiInputRouterResult["diagnostics"] = [];

    while (source.length > 0) {
      const sgrPrefixIndex = source.indexOf(SGR_MOUSE_PREFIX);
      const x10PrefixIndex = source.indexOf(X10_MOUSE_PREFIX);
      const prefixIndex = sgrPrefixIndex < 0
        ? x10PrefixIndex
        : x10PrefixIndex < 0
          ? sgrPrefixIndex
          : Math.min(sgrPrefixIndex, x10PrefixIndex);
      if (prefixIndex < 0) {
        passthrough += source;
        break;
      }
      passthrough += source.slice(0, prefixIndex);
      source = source.slice(prefixIndex);
      if (source.startsWith(X10_MOUSE_PREFIX)) {
        if (source.length < 6) {
          bufferedMousePrefix = source;
          break;
        }
        const sequence = source.slice(0, 6);
        source = source.slice(6);
        const mouseEvent = parseX10MouseSequence(sequence);
        if (mouseEvent) mouseEvents.push(mouseEvent);
        else diagnostics.push("invalid_sgr_mouse");
        continue;
      }
      const terminatorIndex = source.search(/[Mm]/u);
      if (terminatorIndex < 0) {
        if (source.length > limit) diagnostics.push("sgr_mouse_overflow");
        else bufferedMousePrefix = source;
        break;
      }
      const sequence = source.slice(0, terminatorIndex + 1);
      source = source.slice(terminatorIndex + 1);
      const mouseEvent = parseMouseSequence(sequence);
      if (mouseEvent) mouseEvents.push(mouseEvent);
      else diagnostics.push("invalid_sgr_mouse");
    }

    return createResult(passthrough, mouseEvents, diagnostics);
  }

  /** 在输入结束时丢弃残缺鼠标前缀，绝不把其泄漏给文本输入。 */
  function finish(): TuiInputRouterResult {
    if (!bufferedMousePrefix) return createResult();
    bufferedMousePrefix = "";
    return createResult("", [], ["invalid_sgr_mouse"]);
  }

  return { push, finish };
}
