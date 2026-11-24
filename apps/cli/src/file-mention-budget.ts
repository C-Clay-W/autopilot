/** CLI 共用的 @ 文件预算，始终先为已核验的路径预留空间。 */

/** 摘录省略时只提供路径，截断标记随引用传递给模型。 */
export interface FileMentionReference { path: string; label?: string; excerpt?: string; truncated?: true }

type FileMentionGroups = readonly (readonly FileMentionReference[] | undefined)[];

/** 交互提交的原文和文件上下文共用软预算，原文可以超出并保持原样。 */
const FILE_MENTION_CONTEXT_BYTES = 32 * 1024;

/** 生成普通 CLI 的模型输入，也是两种交互入口计算共同预算的格式。 */
export function formatFileMentionContent(content: string, sections?: readonly FileMentionReference[]): string {
  if (!sections?.length) return content;
  const partial = sections.some(function incomplete(section) { return section.excerpt === undefined || section.truncated === true; });
  const block = [
    "<system-reminder>",
    partial ? "用户通过 @ 引用了以下工作区文件，缺少的内容可按路径读取，预览可直接使用路径：" : "用户通过 @ 引用了以下工作区文件，内容已直接附加：",
    ...sections.map(function renderSection(section) {
      if (section.excerpt === undefined) return `--- @${section.path} (仅路径) ---`;
      const label = section.truncated ? "摘录已截断" : section.label;
      return `--- @${section.path} (${label}) ---\n${section.excerpt}`;
    }),
    "</system-reminder>",
  ].join("\n");
  return `${content}\n\n${block}`;
}

/** 对原文和引用应用共同软预算，原文始终保留。 */
export function fitFileMentionContext(content: string, sections?: readonly FileMentionReference[]): readonly FileMentionReference[] | undefined {
  if (!sections?.length) return undefined;
  /** 普通交互按实际发送的 UTF-8 文本计算。 */
  function fits([candidate]: FileMentionGroups) {
    return Buffer.byteLength(formatFileMentionContent(content, candidate), "utf8") <= FILE_MENTION_CONTEXT_BYTES;
  }
  return fits([sections]) ? sections : fitFileMentionReferences([sections], fits)[0];
}

/** 先装入各组路径，再按顺序给摘录分配剩余空间，预算由实际输出格式计算。 */
export function fitFileMentionReferences(groups: FileMentionGroups, fits: (references: FileMentionGroups) => boolean): FileMentionGroups {
  const references: Array<FileMentionReference[] | undefined> = groups.map(function empty() { return undefined; });
  const excerpts: Array<{ reference: FileMentionReference; source: FileMentionReference }> = [];
  for (const [index, group] of groups.entries()) {
    if (!group?.length) continue;
    const selected: FileMentionReference[] = [];
    references[index] = selected;
    for (const source of group) {
      const reference = { path: source.path };
      selected.push(reference);
      if (fits(references)) excerpts.push({ reference, source });
      else selected.pop();
    }
    if (!selected.length) references[index] = undefined;
  }
  for (const { reference, source } of excerpts) {
    if (source.excerpt === undefined) continue;
    reference.excerpt = source.excerpt;
    reference.label = source.label;
    reference.truncated = source.truncated;
    if (fits(references)) continue;
    delete reference.label;
    reference.truncated = true;
    // 按 Unicode 码点查找能装入实际输出的最长前缀。
    const characters = Array.from(source.excerpt);
    let start = 0;
    let end = characters.length;
    while (start < end) {
      const length = Math.ceil((start + end) / 2);
      reference.excerpt = characters.slice(0, length).join("");
      if (fits(references)) start = length;
      else end = length - 1;
    }
    if (start) reference.excerpt = characters.slice(0, start).join("");
    else { delete reference.excerpt; delete reference.truncated; }
  }
  return references;
}
