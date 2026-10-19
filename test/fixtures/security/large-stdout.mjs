/** Stage 0 大输出 fixture：按参数输出字节，默认 1 MiB，不依赖 shell 命令。 */
const bytes = Number.parseInt(process.argv[2] ?? "1048576", 10);
const size = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 1048576;
process.stdout.write("x".repeat(size));
