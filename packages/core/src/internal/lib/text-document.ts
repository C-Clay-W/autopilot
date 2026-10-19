/** 文本与 DOCX 的共享字节提取，供入库和临时分析复用。 */
/** 文本与 DOCX 入库和临时分析共用字节提取，不产生索引。 */
export async function extractTextDocument(bytes: Uint8Array, mimeType: string): Promise<string> {
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

