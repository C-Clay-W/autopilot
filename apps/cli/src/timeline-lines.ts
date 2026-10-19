/** TUI 时间线视觉行模型；统一文字换行、样式片段与源文本坐标，暂不接入渲染。 */

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

/** 时间线原始文本的样式范围；坐标使用 JavaScript 字符串偏移。 */
export interface TimelineTextSpan {
  start: number;
  end: number;
  style: string;
}

/** 可转换为视觉行的安全时间线项。 */
export interface TimelineLineSource {
  itemId: string;
  text: string;
  spans?: TimelineTextSpan[];
}

/** 单条视觉行及其在源文本中的可逆映射。 */
export interface TimelineVisualLine {
  itemId: string;
  text: string;
  displayWidth: number;
  sourceStart: number;
  sourceEnd: number;
  spans: TimelineTextSpan[];
}

/** 视觉行缓存的可观测计数，供定向性能合同确认历史行没有重复换行。 */
export interface TimelineVisualLineCacheStats {
  builds: number;
  hits: number;
  widthInvalidations: number;
}

/** 备用屏视觉行增量缓存的公开内部接口。 */
export interface TimelineVisualLineCache {
  getLines(items: TimelineLineSource[], columns: number): TimelineVisualLine[];
  getStats(): TimelineVisualLineCacheStats;
  clear(): void;
}

/** 将一个样式范围裁剪到当前视觉行，保留行内坐标。 */
function clipTimelineSpans(spans: TimelineTextSpan[], sourceStart: number, sourceEnd: number): TimelineTextSpan[] {
  return spans.flatMap(function clipSpan(span): TimelineTextSpan[] {
    const start = Math.max(span.start, sourceStart);
    const end = Math.min(span.end, sourceEnd);
    return start < end ? [{ ...span, start: start - sourceStart, end: end - sourceStart }] : [];
  });
}

/** 找到包含给定偏移的完整 Unicode grapheme，避免换行截断组合 emoji。 */
function getTimelineGraphemeEnd(source: string, offset: number): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segmenter.segment(source)) {
    const end = segment.index + segment.segment.length;
    if (segment.index < offset && offset < end) return end;
  }
  return offset;
}

/** 复用现有 wrap-ansi 规则生成视觉行，同时把被截断的 grapheme 收拢到同一行。 */
function wrapTimelineSource(source: string, columns: number): Array<{ text: string; sourceStart: number; sourceEnd: number }> {
  const lines: Array<{ text: string; sourceStart: number; sourceEnd: number }> = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const sourceEnd = newline < 0 ? source.length : newline;
    const remaining = source.slice(offset, sourceEnd);
    if (remaining.length === 0) {
      lines.push({ text: "", sourceStart: offset, sourceEnd: offset });
      offset = newline < 0 ? source.length : newline + 1;
      continue;
    }
    const candidate = wrapAnsi(remaining, columns, { hard: true, trim: false, wordWrap: true }).split("\n")[0] ?? remaining;
    const candidateEnd = getTimelineGraphemeEnd(source, offset + candidate.length);
    const visualEnd = Math.min(sourceEnd, Math.max(offset + 1, candidateEnd));
    lines.push({ text: source.slice(offset, visualEnd), sourceStart: offset, sourceEnd: visualEnd });
    offset = visualEnd;
    if (offset === sourceEnd && newline >= 0) offset += 1;
  }
  if (source.endsWith("\n")) lines.push({ text: "", sourceStart: source.length, sourceEnd: source.length });
  return lines;
}

/** 将安全时间线文本按当前终端列宽转换为统一的视觉行。 */
export function createTimelineVisualLines(items: TimelineLineSource[], columns: number): TimelineVisualLine[] {
  const width = Math.max(1, columns);
  return items.flatMap(function createItemLines(item): TimelineVisualLine[] { return createTimelineVisualLinesForItem(item, width); });
}

/** 为单个 source 生成视觉行；缓存与全量实现共用完全相同的换行规则。 */
function createTimelineVisualLinesForItem(item: TimelineLineSource, width: number): TimelineVisualLine[] {
  const spans = item.spans ?? [];
  return wrapTimelineSource(item.text, width).map(function createVisualLine(line): TimelineVisualLine {
    return {
      itemId: item.itemId,
      text: line.text,
      displayWidth: stringWidth(line.text),
      sourceStart: line.sourceStart,
      sourceEnd: line.sourceEnd,
      spans: clipTimelineSpans(spans, line.sourceStart, line.sourceEnd),
    };
  });
}

/** 将 source 的样式范围压成轻量指纹，避免同一文本因新对象重复换行。 */
function getTimelineSpanFingerprint(spans: TimelineLineSource["spans"]): string {
  return (spans ?? []).map(function fingerprintSpan(span): string { return `${span.start}:${span.end}:${span.style}`; }).join("|");
}

/** 创建按 itemId、文本、spans 与终端宽度复用的视觉行缓存。 */
export function createTimelineVisualLineCache(): TimelineVisualLineCache {
  const entries = new Map<string, { text: string; spans: string; width: number; lines: TimelineVisualLine[] }>();
  const stats: TimelineVisualLineCacheStats = { builds: 0, hits: 0, widthInvalidations: 0 };

  /** 按当前 source 顺序拼出视觉行，同时只重算发生变化的 item。 */
  function getLines(items: TimelineLineSource[], columns: number): TimelineVisualLine[] {
    const width = Math.max(1, columns);
    return items.flatMap(function getCachedItemLines(item): TimelineVisualLine[] {
      const spans = getTimelineSpanFingerprint(item.spans);
      const previous = entries.get(item.itemId);
      if (previous && previous.text === item.text && previous.spans === spans && previous.width === width) {
        stats.hits += 1;
        return previous.lines;
      }
      if (previous && previous.width !== width) stats.widthInvalidations += 1;
      const lines = createTimelineVisualLinesForItem(item, width);
      entries.set(item.itemId, { text: item.text, spans, width, lines });
      stats.builds += 1;
      return lines;
    });
  }

  /** 返回当前缓存计数快照，调用方不得修改内部状态。 */
  function getStats(): TimelineVisualLineCacheStats {
    return { ...stats };
  }

  /** 清空视觉行缓存并重置计数，供终端生命周期切换或测试隔离使用。 */
  function clear(): void {
    entries.clear();
    stats.builds = 0;
    stats.hits = 0;
    stats.widthInvalidations = 0;
  }

  return { getLines, getStats, clear };
}
