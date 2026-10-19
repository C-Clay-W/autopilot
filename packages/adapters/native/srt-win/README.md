# Windows 受管执行原生候选

固定源：Anthropic sandbox-runtime commit `6f0ce155ccb136bda33a8a72201fe7f54fe47d9b` 的 `vendor/srt-win-src`；源码/锁文件 SHA 在 source-manifest.json。补丁包含此前 r013 的 stdin 精确帧/转发修复和本轮私有容器停止候选，不复制整份第三方源码入库。

1. `prepare-candidate.ps1 -SourceRoot <固定上游crate> -CandidateRoot <新隔离目录>` 校验输入并依序重放受管执行补丁与 Rust 1.85.1 兼容补丁。
2. `build-candidate.ps1 -CandidateRoot <候选crate> -ToolchainRoot <原r013工具链> -EvidenceRoot <新目录>`：一次离线构建，保存日志/产物 SHA，失败停止。仅为同一候选复用已有 Cargo 缓存时，可传内部参数 `-ReusableTargetRoot <已有target目录>`；该缓存会被 Cargo 修改，不作为不可变证据。构建不执行 exe。
3. 宿主仅显式 `createNodeSandboxPort({ workspaceRoot, windowsSrtWinExe: <候选exe绝对路径>, managedExecutionProtocol: 1 })` 消费。未启用时不改变 runner 选择；启用的后台任务实际握手必须是私有 fd3 的协议 v1，旧 runner/未知布局/错版本失败，不能退回 stdout/taskkill 认证。

Node 公开 `child_process.spawn` 支持额外 stdio pipe；Windows libuv 为之建立 CRT 继承表。候选按实际 STARTUPINFO 表长度、fd3 FOPEN/FPIPE、有效管道 handle 检查能力，不以 Node 版本字符串认证。已源码对照 18.20.8、20.11.0、20.20.2、22.23.0、24.0.0 的布局；这不扩大项目 CLI `>=20.11.0 <22` 支持范围，也不证明所有 Node 版本实机兼容。未知传递机制 fail closed。

broker 只向挂起的真实 runner DuplicateHandle 私有端点，再从该进程复制目标 Job 的 QUERY/TERMINATE handle。目标继承白名单只有标准流，不含控制或 Job；自保护失败在创建目标前拒绝。Job 绑定确认后才创建目标，assign/resume 后才发送 READY、处理排队 stop；TerminateJobObject 后查询 ActiveProcesses=0，再发送 EMPTY。Core 另等包装 close，重复 stop 共享 Promise。断连、坏帧、超时清理不发送成功回执。

额外 Job 副本改变 kill-on-close：broker 在 runner 自然退出时也终止并等待目标容器空，随后释放副本。broker 崩溃时 OS 关闭副本，runner 的既有 broker Job/目标 Job 提供 kill-on-close；该 OS 生命周期仍需另行真实 T06 验证。

公开 Core 能力为通用 ManagedExecutionControl，不暴露 Windows PID/句柄或 native 协议字符串。macOS 仍用原 detached 组 TERM→KILL，有界等待同组消失和包装 close；脱组/setsid 不在范围，未执行 macOS fake/实机测试。原生候选不在默认 npm files allowlist，不改现役 vendored/public runner。构建通过不等于目标启动、全树实机或 0x80070005 根因修复。
