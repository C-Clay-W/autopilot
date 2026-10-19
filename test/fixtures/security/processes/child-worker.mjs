/** Stage 0 子进程树 fixture：保持存活，供父进程 timeout/abort 测试确认树形清理。 */
setInterval(function keepAlive() {}, 1_000);
