/**
 * 大文本文件读取的安全边界：限制扫描、单行和模型可见正文，避免分页 API 退化为无限内存读取。
 */

/** 单次 read_file 最多扫描 8 MiB 原始字节；编辑沿用该文件大小上限。 */
export const MAX_TEXT_SCAN_BYTES = 8 * 1024 * 1024;

/** 单行最多保留 64 Ki 个 UTF-16 code units，防止无换行文件占用无界内存。 */
export const MAX_TEXT_LINE_CHARACTERS = 64 * 1024;

/** 单次 ToolResult 的文本正文最多 256 KiB，避免模型上下文被少量超长行耗尽。 */
export const MAX_READ_RESULT_BYTES = 256 * 1024;
