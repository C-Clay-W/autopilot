/** TUI 时间线视觉行模型；统一文字换行、样式片段与源文本坐标，暂不接入渲染。 */

import stringWidth from "string-width";

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

const timelineSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 一次按词与grapheme顺序换行；ANSI为零宽原子，源坐标不含合成控制序列。 */
function wrapTimelineSource(source: string, columns: number): Array<{ text: string; sourceStart: number; sourceEnd: number }> {
  const lines: Array<{ text: string; sourceStart: number; sourceEnd: number }> = [];
  let lineStart = 0;
  let offset = 0;
  let width = 0;
  /** 只切源字符串一次，不从头扫描已处理的grapheme。 */
  function emit(end: number): void {
    lines.push({ text: source.slice(lineStart, end), sourceStart: lineStart, sourceEnd: end });
    lineStart = end; width = 0;
  }
  const tokens = source.matchAll(/\n| |[^ \n]+/gu);
  for (const token of tokens) {
    const word = token[0];
    if (word === "\n") { emit(offset); offset++; lineStart = offset; continue; }
    const wordWidth = stringWidth(word);
    if (word === " " && width >= columns) emit(offset);
    else if (word !== " " && width > 0 && (wordWidth <= columns ? width + wordWidth > columns : Math.floor((wordWidth - 1) / columns) < Math.floor((wordWidth - (columns - width) - 1) / columns) + 1)) emit(offset);
    const segments = timelineSegmenter.segment(word);
    let local = 0;
    while (local < word.length) {
      const escape = word.charCodeAt(local) === 27 ? /^(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\))/u.exec(word.slice(local))?.[0] : undefined;
      const character = escape ?? (word.charCodeAt(local) >= 32 && word.charCodeAt(local) < 127 && (local + 1 === word.length || word.charCodeAt(local + 1) < 127) ? word[local]! : segments.containing(local)!.segment);
      const characterWidth = escape ? 0 : stringWidth(character);
      if (width > 0 && width + characterWidth > columns) emit(offset);
      width += characterWidth; local += character.length; offset += character.length;
    }
  }
  if (offset > lineStart || source.endsWith("\n")) emit(offset);
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
