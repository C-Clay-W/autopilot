# Stage 0 安全回归 Fixture

本目录为后续安全、Durable State 与 Host 收口阶段提供稳定的测试输入；Fixture 不携带凭证或真实运行时状态。

- `workspace/`：受信任工作区内的普通文件，以及两个不同启动 cwd 的占位目录。
- `outside.txt`：与 workspace 同级、用于验证工作区外访问的文件。
- `large-stdout.mjs`：持续输出固定大小数据，用于 bounded output 测试。
- `processes/`：父子进程树 fixture，用于 timeout/abort 清理测试。
- `jsonl/partially-corrupt.jsonl`：有效记录之间夹有损坏行的 Durable JSONL fixture。
- `session/`：Core 与 Web 使用同一 session ID 的投影 fixture。
