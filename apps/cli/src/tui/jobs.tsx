/** 当前 CLI Session 的后台任务列表、详情与有限安全日志视图。 */

import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliJobView } from "../types.js";
import { TUI_ACCENT_COLOR } from "../design-tokens.js";

/** 将毫秒时间戳格式化为稳定的本地可读时间。 */
function formatJobTime(value: number | undefined): string {
  return value === undefined ? "-" : new Date(value).toLocaleString();
}

/** 渲染单路安全日志，并明确标注缺口、重置和截断事实。 */
function TuiJobOutput(props: { label: string; stream: NonNullable<Extract<CliJobView, { mode: "detail" }>['output']>["stdout"] }): ReactNode {
  const flags = [props.stream.gap ? "gap" : "", props.stream.resetRequired ? "reset" : "", props.stream.truncated ? "truncated" : ""].filter(Boolean).join(", ");
  return <Box flexDirection="column">
    <Text bold>{props.label}{flags ? ` (${flags})` : ""}</Text>
    <Text>{props.stream.text || "(empty)"}</Text>
  </Box>;
}

/** 渲染当前 Job 管理视图；按键由 app.tsx 统一分发，避免创建第二套输入器。 */
export function TuiJobs(props: { view: CliJobView; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  if (props.view.mode === "list") {
    const jobs = props.view.list.jobs;
    return <Box flexDirection="column" borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} aria-role="list">
      <Text bold>Background jobs</Text>
      {jobs.length === 0 ? <Text>No jobs in this session.</Text> : jobs.map(function renderJob(job, index) {
        const selected = index === props.selectedIndex;
        return <Text key={job.jobId} bold={selected} color={selected && props.useColor ? TUI_ACCENT_COLOR : undefined}>
          {selected ? "› " : "  "}{job.jobId} · {job.status} · {job.controlState}{job.canStop ? " · stoppable" : ""}
        </Text>;
      })}
      <Text dimColor={props.useColor}>↑↓ select · Enter details · o output · s stop · r refresh · Esc close{props.screenReader ? " · job list" : ""}</Text>
    </Box>;
  }
  const job = props.view.job;
  return <Box flexDirection="column" borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} aria-role="list">
    <Text bold>Background job</Text>
    <Text>ID: {job.jobId}</Text>
    <Text>Status: {job.status} · Control: {job.controlState} · Stop: {job.canStop ? "available" : "unavailable"}</Text>
    <Text>Started: {formatJobTime(job.startedAt)} · Finished: {formatJobTime(job.finishedAt)} · Exit: {job.exitCode ?? "-"}</Text>
    <Text>Output: stdout {job.stdoutBytes} B · stderr {job.stderrBytes} B{job.outputTruncated ? " · truncated" : ""}</Text>
    {props.view.output ? <>
      <TuiJobOutput label="stdout" stream={props.view.output.stdout} />
      <TuiJobOutput label="stderr" stream={props.view.output.stderr} />
    </> : null}
    <Text dimColor={props.useColor}>o output · s stop · r refresh · Esc back{props.screenReader ? " · job details" : ""}</Text>
  </Box>;
}
