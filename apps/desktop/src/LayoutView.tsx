// 递归呈现最小分屏树，拖动与键盘调整共用比例命令，不修改终端身份。
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Layout } from "./workspace";

interface Props { fit?: boolean; layout: Layout; path?: string; renderPane(id: string): ReactNode; onRatio(path: string, ratio: number): Promise<unknown> | void; onResizing?(active: boolean): void }
interface DividerProps { row: boolean; ratio: number; label: string; min?: number; max?: number; fromEnd?: boolean; onPreview(ratio: number): void; onRatio(ratio: number): Promise<unknown> | void; onResizing?(active: boolean): void }

/** 分屏和浏览器共用指针捕获、键盘步进和拖动结束后的尺寸提交。 */
export function LayoutDivider({ row, ratio, label, min = 0.15, max = 0.85, fromEnd = false, onPreview, onRatio, onResizing }: DividerProps) {
  const cancelDrag = useRef<() => void>(undefined);
  const direction = fromEnd ? -1 : 1;
  /** 拖动中的分隔线离开页面时释放网格冻结。 */
  function observeDrag() { return function dispose() { cancelDrag.current?.(); }; }
  useEffect(observeDrag, []);
  /** 拖动只预览比例，松手后统一提交。 */
  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    const divider = event.currentTarget;
    const bounds = divider.parentElement?.getBoundingClientRect();
    const size = (row ? bounds?.width : bounds?.height) ?? 0;
    if (event.button !== 0 || !size || cancelDrag.current) return;
    event.preventDefault();
    const start = row ? event.clientX : event.clientY;
    const pointerId = event.pointerId;
    let value = ratio;
    divider.setPointerCapture(pointerId);
    onResizing?.(true);
    /** 相对按下位置移动，点击分隔线时布局不跳变。 */
    function move(current: PointerEvent) {
      if (current.pointerId !== pointerId) return;
      const position = row ? current.clientX : current.clientY;
      value = Math.max(min, Math.min(max, ratio + direction * (position - start) / size));
      onPreview(value);
    }
    /** 取消观察后不再处理其他指针事件。 */
    function cleanup() {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      divider.removeEventListener("lostpointercapture", finish);
      cancelDrag.current = undefined;
    }
    /** 保证松手与失去捕获只提交一次。 */
    function finish(current: PointerEvent) {
      if (current.pointerId !== pointerId) return;
      cleanup();
      void Promise.resolve(onRatio(value)).finally(function releaseFit() { onResizing?.(false); });
    }
    cancelDrag.current = function cancel() { cleanup(); onResizing?.(false); };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
    divider.addEventListener("lostpointercapture", finish);
  }
  /** 仅分隔线取得焦点时按 5% 调整。 */
  function keyboardResize(event: React.KeyboardEvent<HTMLDivElement>) {
    const negative = row ? "ArrowLeft" : "ArrowUp";
    const positive = row ? "ArrowRight" : "ArrowDown";
    if (event.key !== negative && event.key !== positive) return;
    event.preventDefault();
    onRatio(Math.max(min, Math.min(max, ratio + direction * (event.key === negative ? -0.05 : 0.05))));
  }
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={row ? "vertical" : "horizontal"} aria-valuenow={Math.round(ratio * 100)} aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)} onPointerDown={startResize} onKeyDown={keyboardResize} className={`z-10 shrink-0 touch-none bg-divider hover:bg-accent focus-visible:bg-accent ${row ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`} />;
}

/** 分隔线只调整当前 Tab 的布局；CSS 在窄窗口保留可滚动的完整窗格。 */
export function LayoutView({ layout, path = "", renderPane, onRatio, onResizing, fit = false }: Props): ReactNode {
  const first = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(window.innerWidth < 1100);
  /** 实际显示轴与指针、键盘、无障碍语义同步，原布局树与比例不变。 */
  function watchWidth() {
    const media = window.matchMedia("(max-width: 1099px)");
    /** 只切换呈现方向，宽度恢复后沿用原轴。 */
    function update() { setNarrow(media.matches); }
    media.addEventListener("change", update);
    update();
    /** 释放当前分屏的尺寸监听。 */
    return function cleanup() { media.removeEventListener("change", update); };
  }
  useEffect(watchWidth, []);
  if (layout.kind === "leaf") return renderPane(layout.id);
  const row = layout.axis === "row" && !narrow;
  /** 拖动只改变这一分屏的局部 CSS 变量。 */
  function preview(ratio: number) { first.current?.style.setProperty("--pane-basis", `${ratio * 100}%`); }
  /** 松手或键盘调整后提交对应布局节点。 */
  function resize(ratio: number) { return onRatio(path, ratio); }
  /** React ref 同步动态比例，尺寸值以 CSS 变量驱动 Tailwind basis。 */
  function bindFirst(element: HTMLDivElement | null) {
    first.current = element;
    if (layout.kind === "split") element?.style.setProperty("--pane-basis", `${layout.ratio * 100}%`);
  }
  return <div className={`flex h-full min-h-0 min-w-0 ${row ? "flex-row" : "flex-col"}`}>
    <div ref={bindFirst} className={`${fit ? "min-h-0 overflow-hidden" : "min-h-64"} min-w-0 basis-(--pane-basis) grow-0 shrink-0`}><LayoutView layout={layout.first} path={`${path}0`} renderPane={renderPane} onRatio={onRatio} onResizing={onResizing} fit={fit} /></div>
    <LayoutDivider row={row} ratio={layout.ratio} label="调整分屏比例" onPreview={preview} onRatio={resize} onResizing={onResizing} />
    <div className={`${fit ? "min-h-0 overflow-hidden" : "min-h-64"} min-w-0 flex-1`}><LayoutView layout={layout.second} path={`${path}1`} renderPane={renderPane} onRatio={onRatio} onResizing={onResizing} fit={fit} /></div>
  </div>;
}
