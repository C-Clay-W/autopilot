// 全局通知只验证队列、权威状态投影及卡片事件，不启动GUI或真实智能体。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { defaultUiPreferences } from "../src/ui-preferences";
import { emptyWorkspace, type Workspace } from "../src/workspace";
import { notificationSnapshot, notifyDesktop, putNotification, removeNotification, subscribeNotifications, taskNotifications } from "../src/desktop-notifications";

/** 构造最小宿主事实，原生CLI状态与第三方观察各保留自己的语义。 */
function workspace(status: "running" | "completed" | "failed", connection: "connected" | "disconnected" = "connected"): Workspace {
  return { ...emptyWorkspace(), tabs: [{ id: "tab", desktopWorkspaceId: "group", name: "Tab 1", directory: null, agent: "ap", layout: null, focused: null, expanded: null, nextNumber: 2, panes: [{ id: "pane", number: 1, generation: 1, process: "shell", task: "unknown", aps: [{ apInstanceId: "ap", lifecycle: "ready", connection, workspace: { workspaceId: "work", stateRootId: "root", projectId: "project", displayName: "project" }, sessions: [{ sessionId: "session", turnId: "turn", selected: true, relation: "locallyDriven", freshness: "fresh", status, execution: status === "running" ? "active" : "inactive", result: status === "running" ? undefined : status, lastSeq: 1 }] }], agents: [{ instanceId: "third", agent: "codex", status, exited: false, observation: "enabled" }] }] }] };
}

test("notifications preserve arrival order across updates and close only one card", function queue() {
  let updates = 0;
  const unsubscribe = subscribeNotifications(function changed() { updates++; });
  putNotification({ group: "notification", lifecycle: "timed", id: "old", title: "旧提示" });
  putNotification({ group: "notification", lifecycle: "timed", id: "approval", title: "审批" });
  putNotification({ group: "notification", lifecycle: "timed", id: "latest", title: "新提示" });
  putNotification({ group: "notification", lifecycle: "timed", id: "approval", title: "审批提交中", busy: true });
  assert.deepEqual(notificationSnapshot().map(function id(item) { return item.id; }), ["old", "approval", "latest"]);
  removeNotification("approval");
  assert.deepEqual(notificationSnapshot().map(function id(item) { return item.id; }), ["old", "latest"]);
  assert.equal(updates, 5);
  unsubscribe();
  removeNotification("old"); removeNotification("latest");
  notifyDesktop("本轮结束", "同一个智能体", "success");
  notifyDesktop("本轮结束", "同一个智能体", "success");
  assert.equal(notificationSnapshot().length, 2);
  assert.notEqual(notificationSnapshot()[0].id, notificationSnapshot()[1].id);
  for (const item of notificationSnapshot()) removeNotification(item.id);
});

test("task notifications use authoritative transitions and skip historical disconnected or observed states", function tasks() {
  const running = workspace("running");
  const completed = workspace("completed");
  assert.equal(taskNotifications(undefined, completed).length, 0);
  const events = taskNotifications(running, completed);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, "任务已完成");
  assert.equal(events[1].title, "本轮结束");
  assert.equal(taskNotifications(completed, completed).length, 0);
  assert.ok(taskNotifications(running, workspace("failed")).every(function error(item) { return item.tone === "error"; }));
  assert.equal(taskNotifications(workspace("running", "disconnected"), completed).length, 1);
  const observed = workspace("completed");
  observed.tabs[0].panes[0].aps![0].sessions[0].relation = "relatedObserved";
  observed.tabs[0].panes[0].agents![0].observation = "disabled";
  assert.equal(taskNotifications(running, observed).length, 0);
  // 相同权威任务在两个窗格出现时只通知一次。
  const duplicate = workspace("completed");
  duplicate.tabs[0].panes.push(structuredClone(duplicate.tabs[0].panes[0]));
  assert.equal(taskNotifications(running, duplicate).length, 2);
});

test("global cards use the notification window portal with latest last and busy confirmations resist dismissal", function cards() {
  const require = createRequire(__filename);
  const reactPath = require.resolve("react");
  const domPath = require.resolve("react-dom");
  const react = require(reactPath);
  const dom = require(domPath);
  const oldReact = require.cache[reactPath];
  const oldDom = require.cache[domPath];
  const oldDocument = globalThis.document;
  const popupBody = {};
  let portalTarget: unknown;
  const effects: Array<() => unknown> = [];
  require.cache[reactPath] = { ...oldReact, exports: { ...react, useSyncExternalStore: function snapshot(_subscribe: unknown, get: () => unknown) { return get(); }, useState: function state() { return [popupBody, function update() {}]; }, useRef: function ref() { return { current: null }; }, useEffect: function effect(run: () => unknown) { effects.push(run); } } } as NodeModule;
  require.cache[domPath] = { ...oldDom, exports: { ...dom, createPortal: function portal(children: unknown, target: unknown) { portalTarget = target; return children; } } } as NodeModule;
  globalThis.document = { body: {} } as Document;
  try {
    const { DesktopNotifications, DesktopConfirmation } = require("../src/components/ui/notifications");
    let denied = 0;
    const request = { group: "notification" as const, lifecycle: "user" as const, id: "approval", title: "待审批", content: react.createElement("button", null, "仅本次"), onDismiss: function deny() { denied++; } };
    DesktopConfirmation(request);
    const lifetime = effects.splice(0).map(function commit(effect) { return effect(); });
    putNotification({ group: "notification", lifecycle: "timed", id: "latest", title: "最新" });
    const windows = DesktopNotifications({ ui: defaultUiPreferences() }).props.children;
    const root = windows[1].type(windows[1].props);
    assert.equal(portalTarget, popupBody);
    assert.match(root.props.className, /overflow-y-auto/);
    assert.deepEqual(root.props.children.map(function id(item: any) { return item.key; }), ["approval", "latest"]);
    const approval = root.props.children[0].type(root.props.children[0].props);
    const escape = { key: "Escape", nativeEvent: { isComposing: false }, stopPropagation: function stop() {} };
    approval.props.onKeyDown(escape);
    assert.equal(denied, 1);
    assert.equal(notificationSnapshot().length, 2);
    putNotification({ ...request, busy: true });
    const updated = DesktopNotifications({ ui: defaultUiPreferences() }).props.children[1];
    const busyCard = updated.type(updated.props).props.children[0];
    busyCard.type(busyCard.props).props.onKeyDown(escape);
    assert.equal(denied, 1);
    for (const dispose of lifetime) if (typeof dispose === "function") dispose();
    assert.deepEqual(notificationSnapshot().map(function id(item) { return item.id; }), ["latest"]);
  } finally {
    require.cache[reactPath] = oldReact; require.cache[domPath] = oldDom;
    globalThis.document = oldDocument;
    for (const item of notificationSnapshot()) removeNotification(item.id);
  }
});
