/** 单窗口唯一追加输出所有者：跨会话与resize保持Static挂载，稳定键只输出一次。 */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, Static } from "ink";
interface InlineItem { key: string; node?: ReactNode; sequence?: number; render?(after?: number): ReactNode }
const InlineOutputContext = createContext<((items: InlineItem[]) => void) | undefined>(undefined);
/** 在会话壳之外持有追加列表，避免子会话卸载导致历史重放。 */
export function TuiInlineOutputOwner(props: { children: ReactNode }): ReactNode {
  const seen = useRef(new Map<string, number | undefined>());
  const [items, setItems] = useState<InlineItem[]>([]);
  const append = useCallback(function append(next: InlineItem[]) {
    const fresh: InlineItem[] = [];
    for (const item of next) {
      const previous = seen.current.get(item.key);
      if (seen.current.has(item.key) && (item.sequence === undefined || item.sequence <= (previous ?? -1))) continue;
      seen.current.set(item.key, item.sequence);
      fresh.push({ key: `${item.key}:${item.sequence ?? "once"}`, node: item.render ? item.render(previous) : item.node });
    }
    if (fresh.length) setItems(function add(current) { return [...current, ...fresh]; });
  }, []);
  return <InlineOutputContext.Provider value={append}><Static items={items}>{function render(item) { return <Box key={item.key} flexDirection="column">{item.node}</Box>; }}</Static>{props.children}</InlineOutputContext.Provider>;
}
/** 只提交新稳定内容，父所有者存在时不创建第二个Static。 */
export function TuiInlineOutput(props: { items: InlineItem[] }): ReactNode {
  const append = useContext(InlineOutputContext);
  useLayoutEffect(function publish() { append?.(props.items); }, [append, props.items]);
  if (append) return null;
  return <TuiInlineOutputOwner><TuiInlineOutput {...props} /></TuiInlineOutputOwner>;
}
