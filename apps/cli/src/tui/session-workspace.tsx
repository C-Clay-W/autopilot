/** inline单窗口会话壳：目录按需分页，仅当前会话挂载正文，输入按原目标隔离。 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { Box, Text, useInput, useStdout, type Key } from "ink";
import { TuiApprovalPrompt, createTuiApprovalOptions } from "./approval.js";
import { readTuiTerminalSize } from "./format.js";
import { TuiInlineOutputOwner } from "./inline-output.js";
import { CliTuiApp } from "./app.js";
import type { CliProjection } from "../types.js";
import { getCliInteractionLabel } from "./session-manager.js";
import type { CliSessionManager, CliSessionEntry, CliSessionDirectoryItem } from "./session-manager.js";

/** 仅已打开/关联目标拥有Store，普通目录项不为展示创建重型对象。 */
function isLoadedSession(entry: CliSessionDirectoryItem): entry is CliSessionEntry { return "store" in entry; }

/** 按Session保存草稿引用，仅挂载当前正文；目录选择不执行或取消Turn。 */
export function CliSessionWorkspace(props: Omit<ComponentProps<typeof CliTuiApp>, "controller" | "store" | "onResult"> & { manager: CliSessionManager; onResult(result: Parameters<ComponentProps<typeof CliTuiApp>["onResult"]>[0]): void }) {
  const { stdout } = useStdout();
  const terminalSizeSource = props.terminalSizeSource ?? stdout;
  const initialSessionId = useRef(props.manager.selected().sessionId);
  const [, setVersion] = useState(0);
  const [size, setSize] = useState(function initialSize() { return readTuiTerminalSize(terminalSizeSource); });
  const { columns, rows } = size;
  const [management, setManagement] = useState(false);
  const managementRef = useRef(false);
  const [requestsOnly, setRequestsOnly] = useState(false);
  const requestsOnlyRef = useRef(false);
  /** 同一事件批次内管理目录立即生效，避免 Ctrl+T 后方向键沿旧关联列表路由。 */
  function updateManagement(value: boolean): void { managementRef.current = value; setManagement(value); }
  const [approval, setApproval] = useState<{ sessionId: string; turnId: string; approvalId: string; pending: NonNullable<CliProjection["pendingApproval"]>; retry?: boolean }>();
  const approvalRef = useRef(approval);
  const [decisionIndex, setDecisionIndex] = useState(0);
  const decisionRef = useRef(0);
  const [detailOffset, setDetailOffset] = useState(0);
  const [details, setDetails] = useState(false);
  const approvalMaximumRef = useRef(0);
  const submittingRef = useRef(false);
  const approvalSubmissions = useRef(new Set<string>());
  const approvalOrder = useRef(new Map<string, number>());
  const [open, setOpen] = useState((terminalSizeSource.columns ?? 80) >= 110);
  const [listFocused, setListFocused] = useState(false);
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [draftAttachments, setDraftAttachments] = useState<Record<string, string[]>>({});
  const indexRef = useRef(0);
  const consumedInputRef = useRef(false);
  const forwardingInputRef = useRef(false);
  const directoryLoadingRef = useRef(false);
  const directoryKeysRef = useRef<Array<{ value: string; key: Key }>>([]);
  const activeInputRef = useRef<{ sessionId: string; handle?: (value: string, key: Key) => void } | undefined>(undefined);
  const queuedKeysRef = useRef<Array<{ sessionId: string; value: string; key: Key }>>([]);
  const offsetRef = useRef(0);
  const modeRef = useRef({ open: (terminalSizeSource.columns ?? 80) >= 110, focused: false, epoch: 0 });
  const selected = props.manager.selected();
  const selectedState = selected.store.getSnapshot();
  const todo = [...selectedState.liveEvents].reverse().find(function todo(event) { return event.type === "todo_updated"; });
  const stage = todo?.type === "todo_updated" ? todo.todos.find(function active(item) { return item.status === "in_progress"; })?.activeForm : undefined;
  const attachments = [...new Set([...(selected.attachments ?? []), ...(draftAttachments[selected.sessionId] ?? [])])];
  const related = props.manager.related();
  const approvalCards = related.flatMap(function pendingCard(entry) {
    const state = entry.store.getSnapshot();
    if (!state.pendingApproval || !state.liveTurnId || state.status !== "waiting_approval") return [];
    const identity = JSON.stringify([entry.sessionId, state.liveTurnId, state.pendingApproval.approvalId]);
    if (!approvalOrder.current.has(identity)) approvalOrder.current.set(identity, approvalOrder.current.size);
    return [{ entry, identity, sessionId: entry.sessionId, turnId: state.liveTurnId, approvalId: state.pendingApproval.approvalId, pending: state.pendingApproval }];
  }).sort(function arrival(a, b) { return approvalOrder.current.get(a.identity)! - approvalOrder.current.get(b.identity)!; });
  const recoveryCards = related.flatMap(function savedDecision(entry) {
    const view = entry.executionView;
    const event = view?.interaction?.approval?.event;
    if (entry.controller.isExecuting?.() || view?.interaction?.state !== "decided" || event?.type !== "approval_required" || view.interaction.continuation?.failureDiagnostic?.started || (view.interaction.continuation && view.interaction.continuation.state !== "failed") || (view.continuation ?? view.interaction.continuation)?.failureCode === "BOUNDARY_CHANGED") return [];
    return [{ entry, sessionId: entry.sessionId, turnId: view.turnId, approvalId: event.result.approval.approvalId, pending: { approvalId: event.result.approval.approvalId, toolName: event.toolName, reason: "审批决定已保存" }, retry: true }];
  });
  const focusableCards = [...approvalCards, ...recoveryCards];
  const refreshingApproval = [selected, ...related].some(function loading(entry) { return entry.summaryStatus === "waiting_approval" && !entry.summaryReady; });
  /** 真实问题请求定位沿用原列表Enter语义，不把普通running目标混成审批。 */
  function requestEntries(): CliSessionEntry[] {
    return props.manager.related().filter(function actionable(entry) {
      const state = entry.store.getSnapshot();
      const view = entry.executionView;
      const question = state.status === "waiting_user_input" && Boolean(entry.controller.getProjection().questionRequestId)
        && (!view || view.waiting === "user_input" && view.interaction?.state === "pending");
      return question || focusableCards.some(function same(card) { return card.sessionId === entry.sessionId; });
    });
  }
  const listedEntries = management ? props.manager.directory() : requestsOnly ? requestEntries() : related;
  const hasSidebarContent = related.length > 0 || attachments.length > 0 || Boolean(stage);
  const fullscreen = props.renderMode === "alternate-screen" && !props.screenReader;
  const wide = columns >= 110 && fullscreen;
  const bodyRows = Math.max(1, rows - (approval && !approval.retry ? 15 : 5));
  const visibleRows = Math.max(1, bodyRows - 4);
  const sidebarRows = [
    ...listedEntries.flatMap(function session(entry, rowIndex) {
      if (management || !isLoadedSession(entry)) return [{ text: `${entry.sessionId === selected.sessionId ? "▶ " : "  "}${entry.title}`, sessionIndex: rowIndex }];
      const state = entry.store.getSnapshot();
      const todo = [...state.liveEvents].reverse().find(function latest(event) { return event.type === "todo_updated"; });
      const phase = todo?.type === "todo_updated" ? todo.todos.find(function active(item) { return item.status === "in_progress"; })?.activeForm : undefined;
      const label = getCliInteractionLabel(entry.executionView) ?? (state.pendingApproval ? "待审批" : state.status === "waiting_user_input" ? "等待回答" : state.status === "completed" ? "已完成" : state.status === "failed" ? "失败/阻塞" : state.status);
      return [{ text: `${entry.sessionId === selected.sessionId ? "▶ " : "  "}${entry.title}`, sessionIndex: rowIndex }, { text: `  ${label}${phase ? ` · ${phase}` : ""}${entry.unread ? " 未读" : ""}`, sessionIndex: rowIndex }];
    }),
    ...(!management && attachments.length ? [{ text: "附件", sessionIndex: -1 }, ...attachments.map(function attachment(name) { return { text: name.replace(/[\x00-\x1f\x7f]/gu, " "), sessionIndex: -1 }; })] : []),
    ...(!management && stage ? [{ text: "当前阶段", sessionIndex: -1 }, { text: stage, sessionIndex: -1 }] : []),
  ];
  const showList = open && (listFocused || (wide && hasSidebarContent));
  const listWidth = wide && showList ? 30 : 0;

  useEffect(function subscribeDirectory() { return props.manager.subscribe(function changed() { setVersion(function next(value) { return value + 1; }); }); }, [props.manager]);
  useEffect(function observeTerminalSize() {
    function resize() { setSize(readTuiTerminalSize(terminalSizeSource)); }
    terminalSizeSource.on?.("resize", resize);
    return function release() { terminalSizeSource.off?.("resize", resize); };
  }, [terminalSizeSource]);
  useLayoutEffect(function commitRootSize() { props.onTerminalSizeChange?.(size); }, [size, props.onTerminalSizeChange]);
  /** 独立侧栏窗口保持有界；增删内容和resize不会把正文滚动位置带入侧栏。 */
  function updateOffset(next: number): void {
    const bounded = Math.max(0, Math.min(Math.max(0, sidebarRows.length - visibleRows), next));
    offsetRef.current = bounded; setOffset(bounded);
  }
  /** 连续方向键紧接Enter使用同步索引，不依赖React渲染闭包。 */
  function updateIndex(next: number): void {
    const bounded = Math.max(0, Math.min((managementRef.current ? props.manager.directory() : requestsOnlyRef.current ? requestEntries() : props.manager.related()).length - 1, next));
    indexRef.current = bounded; setIndex(bounded);
    const row = bounded * (managementRef.current ? 1 : 2);
    if (row < offsetRef.current) updateOffset(row);
    else if (row + 1 >= offsetRef.current + visibleRows) updateOffset(row - visibleRows + 2);
  }
  /** 模式与消费代次同步提交，保留原输入隔离机制。 */
  function updateMode(nextOpen: boolean, focused: boolean): void {
    // Ink逐订阅者batchedUpdates可在同一按键分发中commit新闭包；保留事件周期消费标记。
    consumedInputRef.current = true;
    queueMicrotask(function releaseConsumedInput() { consumedInputRef.current = false; });
    modeRef.current = { open: nextOpen, focused, epoch: modeRef.current.epoch + 1 };
    setVersion(function publishMode(value) { return value + 1; });
    setOpen(nextOpen); setListFocused(focused);
    if (!focused) { updateManagement(false); requestsOnlyRef.current = false; setRequestsOnly(false); }
  }
  /** 按实时open与展示条件判定可见面板，不能把未聚焦的可见侧栏漏给取消入口。 */
  function isPanelVisible(): boolean { return modeRef.current.open && (modeRef.current.focused || (wide && hasSidebarContent)); }

  /** 仅显式快捷键移动审批焦点，自动到达的请求保留主输入。 */
  function focusApproval(index: number): void {
    const card = focusableCards[index];
    if (!card) return;
    approvalRef.current = card; setApproval(card); decisionRef.current = 0; setDecisionIndex(0); setDetails(false); setDetailOffset(0); updateMode(false, false);
  }

  /** 仅根桥转发允许越过本批次消费标记，其他Ink订阅仍受标记保护。 */
  function forwardInput(value: string, key: Key): void {
    forwardingInputRef.current = true;
    try { activeInputRef.current?.handle?.(value, key); }
    finally { forwardingInputRef.current = false; }
  }

  /** 根路由按接收时模式处理一次输入，异步目录只回放同代次列表按键。 */
  function handleSessionList(value: string, key: Key): void {
    if (submittingRef.current) { if (key.ctrl && value === "c") props.onRequestInterrupt(); return; }
    if (key.ctrl && value === "c" && modeRef.current.focused) { props.onRequestInterrupt(); return; }
    if (key.ctrl && value === "t") {
      const approvalFocused = approvalRef.current !== undefined;
      approvalRef.current = undefined; setApproval(undefined);
      requestsOnlyRef.current = false; setRequestsOnly(false);
      updateManagement(true);
      if (!approvalFocused && modeRef.current.open && modeRef.current.focused) updateMode(false, false);
      else {
        updateMode(true, true);
        updateIndex(props.manager.directory().findIndex(function current(entry) { return entry.sessionId === props.manager.selected().sessionId; }));
        const epoch = modeRef.current.epoch;
        directoryLoadingRef.current = true; directoryKeysRef.current = [];
        void props.manager.loadDirectory().then(function loaded() {
          if (modeRef.current.epoch !== epoch) return;
          directoryLoadingRef.current = false;
          const keys = directoryKeysRef.current; directoryKeysRef.current = [];
          for (const item of keys) handleSessionList(item.value, item.key);
        }).catch(function failed() { selected.store.addNotice("历史目录暂不可用"); }).finally(function release() { if (modeRef.current.epoch === epoch) directoryLoadingRef.current = false; });
      }
      return;
    }
    if (directoryLoadingRef.current && managementRef.current && modeRef.current.focused && !key.ctrl && !key.escape && value !== "\u001b") {
      directoryKeysRef.current.push({ value, key }); return;
    }
    if (approvalRef.current) {
      consumedInputRef.current = true;
      queueMicrotask(function releaseApprovalInput() { consumedInputRef.current = false; });
      const frozen = approvalRef.current;
      if (key.ctrl && value === "a") { focusApproval((focusableCards.findIndex(function same(card) { return card.sessionId === frozen.sessionId && card.turnId === frozen.turnId && card.approvalId === frozen.approvalId; }) + 1) % focusableCards.length); return; }
      if (key.escape || value === "\u001b") { approvalRef.current = undefined; setApproval(undefined); return; }
      if (key.ctrl && value === "c") { props.onRequestInterrupt(); return; }
      if (frozen.retry) {
        if (!key.return) return;
        const card = recoveryCards.find(function same(card) { return card.sessionId === frozen.sessionId && card.turnId === frozen.turnId && card.approvalId === frozen.approvalId; });
        approvalRef.current = undefined; setApproval(undefined);
        if (card) void card.entry.controller.resume({ turnId: frozen.turnId, approvalId: frozen.approvalId }).then(function result(result) { props.manager.handleResult(card.entry, result); }).catch(function failed() { card.entry.store.addNotice("审批决定已保存，恢复执行失败，请重试原决定继续"); }).finally(function refresh() { void props.manager.refresh().catch(function failed() { card.entry.store.addNotice("当前恢复状态暂不可用"); }); });
        return;
      }
      if (value === "d") { setDetails(function toggle(current) { return !current; }); setDetailOffset(0); return; }
      if (key.pageDown) setDetailOffset(function down(current) { return Math.min(current + Math.max(1, bodyRows - 5), approvalMaximumRef.current); });
      if (key.pageUp) setDetailOffset(function up(current) { return Math.max(0, current - Math.max(1, bodyRows - 5)); });
      const options = createTuiApprovalOptions(frozen.pending);
      if (key.upArrow || key.downArrow) { decisionRef.current = Math.max(0, Math.min(options.length - 1, decisionRef.current + (key.downArrow ? 1 : -1))); setDecisionIndex(decisionRef.current); }
      if (key.return && !submittingRef.current) {
        const target = props.manager.entries().find(function match(entry) { return entry.sessionId === frozen.sessionId; });
        const state = target?.store.getSnapshot();
        if (!target || state?.liveTurnId !== frozen.turnId || state?.pendingApproval?.approvalId !== frozen.approvalId || state.status !== "waiting_approval") { selected.store.addNotice("审批请求已失效，正在刷新当前请求"); approvalRef.current = undefined; setApproval(undefined); void props.manager.refresh().catch(function failed() { selected.store.addNotice("当前审批暂不可用，请重试"); }); return; }
        const identity = JSON.stringify([frozen.sessionId, frozen.turnId, frozen.approvalId]);
        if (approvalSubmissions.current.has(identity)) return;
        approvalSubmissions.current.add(identity);
        target.store.recordApprovalSubmission(options[decisionRef.current]!.decision);
        approvalRef.current = undefined; setApproval(undefined); updateMode(wide && modeRef.current.open, false);
        void target.controller.dispatch({ type: "approve", expected: { sessionId: frozen.sessionId, turnId: frozen.turnId, approvalId: frozen.approvalId }, decision: options[decisionRef.current]!.decision }).then(function result(result) { props.manager.handleResult(target, result); }).catch(function failed() { target.store.addNotice("审批提交或恢复失败，请核对当前决定后重试继续"); }).finally(function release() { approvalSubmissions.current.delete(identity); void props.manager.refresh().catch(function failed() { target.store.addNotice("当前审批状态暂不可用"); }); });
      }
      return;
    }
    if (key.ctrl && value === "a") {
      const card = focusableCards[0];
      if (card) focusApproval(0);
      else {
        updateManagement(false);
        if (requestEntries().length) {
          requestsOnlyRef.current = true; setRequestsOnly(true);
          updateIndex(0); updateMode(true, true);
        } else {
          updateMode(wide && modeRef.current.open, false);
          selected.store.addNotice("暂无待处理审批/问答或可安全重试的请求；Ctrl+T查看会话");
        }
      }
      return;
    }
    if (key.ctrl && value === "l") { consumedInputRef.current = true; queueMicrotask(function release() { consumedInputRef.current = false; }); void props.manager.loadHistory().catch(function failed() { selected.store.addNotice("历史页暂不可用"); }); return; }
    if ((key.escape || value === "\u001b") && isPanelVisible()) { updateMode(false, false); return; }
    if (!modeRef.current.focused) {
      const sessionId = props.manager.selected().sessionId;
      if (activeInputRef.current?.sessionId === sessionId && activeInputRef.current.handle) forwardInput(value, key);
      else if (listFocused || approval || activeInputRef.current?.sessionId !== sessionId) queuedKeysRef.current.push({ sessionId, value, key });
      return;
    }
    if (key.pageUp) updateOffset(offsetRef.current - visibleRows);
    if (key.pageDown) {
      if (managementRef.current && offsetRef.current + visibleRows >= sidebarRows.length) void props.manager.loadDirectory().catch(function failed() { selected.store.addNotice("历史目录暂不可用"); });
      updateOffset(offsetRef.current + visibleRows);
    }
    if (key.upArrow) updateIndex(indexRef.current - 1);
    if (key.downArrow) updateIndex(indexRef.current + 1);
    const target = (managementRef.current ? props.manager.directory() : requestsOnlyRef.current ? requestEntries() : props.manager.related())[indexRef.current];
    if (key.return && target) {
      const state = isLoadedSession(target) ? target.store.getSnapshot() : undefined;
      if (!managementRef.current && state?.pendingApproval && state.liveTurnId && state.status === "waiting_approval") {
        const frozen = { sessionId: target.sessionId, turnId: state.liveTurnId, approvalId: state.pendingApproval.approvalId, pending: state.pendingApproval };
        approvalRef.current = frozen; setApproval(frozen); decisionRef.current = 0; setDecisionIndex(0); setDetails(false); setDetailOffset(0); updateMode(true, true);
      } else if (managementRef.current || state?.status === "waiting_user_input") {
        const targetId = target.sessionId;
        submittingRef.current = true; updateMode(wide && modeRef.current.open, false);
        void props.manager.select(targetId).catch(function failed() { selected.store.addNotice("会话历史暂不可用"); }).finally(function release() { submittingRef.current = false; });
      } else if (!managementRef.current) {
        const saved = recoveryCards.find(function same(card) { return card.sessionId === target.sessionId; });
        if (saved) { focusApproval(focusableCards.indexOf(saved)); return; }
        selected.store.addNotice("该会话暂无可处理请求；Ctrl+T可查看会话");
        void props.manager.refresh().catch(function failed() { selected.store.addNotice("当前请求状态暂不可用，请重试"); });
      }
    }
  }
  useInput(handleSessionList);
  useEffect(function bindSidebarMouse() {
    if (!listFocused || !props.mouseInput) return;
    props.mouseInput.setHandler(function scroll(event, notches) { if (event.kind === "wheel_up") updateOffset(offsetRef.current - 3 * notches); if (event.kind === "wheel_down") updateOffset(offsetRef.current + 3 * notches); });
    return function release() { props.mouseInput?.setHandler(undefined); };
  }, [listFocused, props.mouseInput, sidebarRows.length, visibleRows]);

  const activeApproval = approval && props.manager.entries().find(function target(entry) { return entry.sessionId === approval.sessionId; });
  const approvalValid = activeApproval && (approval?.retry ? recoveryCards.some(function same(card) { return card.sessionId === approval.sessionId && card.turnId === approval.turnId && card.approvalId === approval.approvalId; }) : activeApproval.store.getSnapshot().status === "waiting_approval" && activeApproval.store.getSnapshot().liveTurnId === approval?.turnId && activeApproval.store.getSnapshot().pendingApproval?.approvalId === approval?.approvalId);
  useEffect(function dismissStaleApproval() { if (approval && !approvalValid) { approvalRef.current = undefined; setApproval(undefined); } }, [approval, approvalValid]);
  const listOffset = Math.max(0, Math.min(offset, Math.max(0, sidebarRows.length - visibleRows)));
  const list = <Box flexDirection="column" width={wide ? 30 : Math.max(1, columns)} height={bodyRows} flexShrink={0} overflow="hidden" borderStyle="single" aria-label="会话与附件侧栏，方向键选择，Enter切换，PgUp/PgDn滚动，Esc关闭">
    <Text wrap="truncate">{management ? "会话" : "关联任务"} · {listFocused ? "↑↓/Enter · Esc关闭" : "Ctrl+A审批 · Esc关闭"}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">{sidebarRows.slice(listOffset, listOffset + visibleRows).map(function row(item, localIndex) { return <Text key={listOffset + localIndex} inverse={listFocused && item.sessionIndex >= 0 && item.sessionIndex === index} wrap="truncate">{item.text}</Text>; })}</Box>
    <Text wrap="truncate">{listOffset + 1}–{Math.min(sidebarRows.length, listOffset + visibleRows)}/{sidebarRows.length} · {management && props.manager.directoryState().loading ? "加载中" : management && props.manager.directoryState().more ? "PgDn继续加载" : "PgUp/PgDn"}</Text>
  </Box>;
  return <TuiInlineOutputOwner><Box flexDirection="column" width={columns} height={fullscreen ? Math.max(1, rows - 1) : undefined} overflow="hidden">
    <Box flexDirection="row" height={fullscreen ? bodyRows : undefined} flexShrink={0} overflow="hidden">
      {!wide && showList && !approval ? list : null}
      <Box flexDirection="column" width={Math.max(1, columns - listWidth)} height={fullscreen ? bodyRows : undefined} display={!wide && showList && !approval ? "none" : "flex"}>
        {[selected].map(function currentSession(entry) {
          const visible = true;
          return <Box key={entry.sessionId} display={visible ? "flex" : "none"} flexDirection="column">
            <CliTuiApp {...props} sessionTitle={entry.title} interactionLabel={getCliInteractionLabel(entry.executionView)} inlineOutputKey={entry.sessionId} bindInputHandler={function bindCurrentSessionInput(handle) { activeInputRef.current = { sessionId: entry.sessionId, handle }; if (handle && !modeRef.current.focused && !approvalRef.current) { const keys = queuedKeysRef.current; queuedKeysRef.current = []; for (const item of keys) if (item.sessionId === entry.sessionId) forwardInput(item.value, item.key); } }} viewState={entry.viewState} store={entry.store} controller={entry.controller} initial={entry.sessionId === initialSessionId.current && !entry.viewState.initialStarted ? props.initial : undefined} closeWhenIdle={false} visible={visible} inputActive={visible && !listFocused && !approval} escapeClosesPanel={showList} canReceiveInput={function acceptsCurrentInput(value, key) { const reservedKey = (key?.escape || value === "\u001b") && isPanelVisible() || key?.ctrl && (value === "t" || value === "a" || value === "l"); return !submittingRef.current && !approvalRef.current && (!consumedInputRef.current || forwardingInputRef.current) && !reservedKey && !modeRef.current.focused && props.manager.selected().sessionId === entry.sessionId; }} onDraftAttachmentsChange={function attachmentsChanged(names) { setDraftAttachments(function update(current) { return (current[entry.sessionId] ?? []).join("\0") === names.join("\0") ? current : { ...current, [entry.sessionId]: names }; }); }} onTerminalSizeChange={undefined} availableColumns={Math.max(1, columns - listWidth)} availableRows={bodyRows} onResult={function fixedResult(result) { props.manager.handleResult(entry, result); props.onResult(result); }} />
          </Box>;
        })}
      </Box>
      {wide && showList && !approval ? list : null}
    </Box>
    {approvalCards.filter(function focused(card) { return approval?.sessionId === card.sessionId && approval.approvalId === card.approvalId; }).map(function card(card) {
      const focused = approval?.sessionId === card.sessionId && approval.turnId === card.turnId && approval.approvalId === card.approvalId;
      return <Box key={card.identity} flexDirection="column">
        <Text wrap="truncate">{card.entry.title} · 关联任务审批 · {focused ? "已聚焦 · d详情 · PgUp/PgDn · Esc返回输入" : "Ctrl+A聚焦，输入草稿保持可用"}</Text>
        <TuiApprovalPrompt height={8} offset={focused ? detailOffset : 0} onMaximumOffset={focused ? function rememberMaximum(maximum) { approvalMaximumRef.current = maximum; } : undefined} pendingApproval={card.pending} selectedIndex={focused ? decisionIndex : 0} useColor={props.useColor} screenReader={props.screenReader} details={focused && details} />
        {focused ? <Text wrap="truncate">{approvalValid ? `Enter确认：${createTuiApprovalOptions(card.pending)[decisionIndex]?.label}` : "请求已失效"}</Text> : null}
      </Box>;
    })}
    {recoveryCards.filter(function focused(card) { return approval?.retry && approval.sessionId === card.sessionId; }).map(function retry(card) { return <Text wrap="truncate" key={JSON.stringify([card.sessionId, card.turnId, card.approvalId])}>{card.entry.title} · {getCliInteractionLabel(card.entry.executionView)} · {approval?.retry && approval.sessionId === card.sessionId ? "Enter重试原决定 · Esc返回输入" : "Ctrl+A聚焦重试"}</Text>; })}
    {related.some(function pending(entry) { return entry.store.getSnapshot().pendingApproval !== undefined; }) ? <Text wrap="truncate">关联任务等待审批 · Ctrl+A原地处理</Text> : null}
    {refreshingApproval ? <Text wrap="truncate">正在刷新当前审批 · 旧请求不可操作</Text> : null}
    <Text wrap="truncate">Ctrl+A审批/回答 · Ctrl+T会话 · Ctrl+L{selected.historyMore ? "加载历史页" : "刷新新增"} · /resume恢复 · Ctrl+C退出</Text>
  </Box></TuiInlineOutputOwner>;
}
