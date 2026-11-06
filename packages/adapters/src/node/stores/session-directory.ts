/** 轻量Session目录读取：流式校验JSON结构，仅保留顶层身份/标题，跳过presentation正文。 */
import fs from "node:fs";
import { NodeStateError } from "../node-errors";
import { normalizeNodeSession } from "../session-record";

const DIRECTORY_FIELDS = new Set(["id", "title", "productMode", "projectId", "chatRetrievalMode", "createdAt", "updatedAt", "status", "activeTurnId"]);
type Frame = { kind: "object" | "array"; expect: "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd"; key?: string };

/** 在固定大小分片中严格验证token/容器顺序，不构造正文字符串、数组或对象。 */
export async function readSessionDirectoryRecord(filePath: string, id: string) {
  const fields: Record<string, unknown> = {};
  const stack: Frame[] = [];
  let root = false;
  let finished = false;
  let token: "string" | "primitive" | undefined;
  let text = "";
  let capture = false;
  let keyToken = false;
  let target: string | undefined;
  let escaped = false;
  let unicode = 0;

  /** 固定错误码不泄漏路径或原始数据。 */
  function invalid(): never { throw new NodeStateError("STATE_SESSION_CORRUPTED"); }

  /** 消费一个值并推进父容器，根只接受对象。 */
  function beginValue(): string | undefined {
    if (!stack.length) { if (root) invalid(); root = true; return undefined; }
    const frame = stack[stack.length - 1]!;
    if (frame.expect !== "value" && frame.expect !== "valueOrEnd") invalid();
    frame.expect = "commaOrEnd";
    return stack.length === 1 && frame.kind === "object" && frame.key && DIRECTORY_FIELDS.has(frame.key) ? frame.key : undefined;
  }

  /** 提交已完成的JSON标量；未选中的长正文不会累积在内存中。 */
  function finishToken(): void {
    if (keyToken) {
      const frame = stack[stack.length - 1]!;
      frame.key = stack.length === 1 ? JSON.parse(text) as string : undefined;
      frame.expect = "colon";
    } else if (target) fields[target] = JSON.parse(text);
    token = undefined; text = ""; target = undefined;
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 16 * 1024 });
  for await (const chunk of stream) {
    for (const character of chunk as string) {
      if (token === "string") {
        if (capture) text += character;
        if (unicode) { if (!/[0-9a-f]/iu.test(character)) invalid(); unicode--; continue; }
        if (escaped) { if (character === "u") unicode = 4; else if (!/["\\/bfnrt]/u.test(character)) invalid(); escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (character === '"') { finishToken(); continue; }
        if (character.charCodeAt(0) < 32) invalid();
        continue;
      }
      if (token === "primitive") {
        if (!/[ \t\r\n,}\]]/u.test(character)) { text += character; if (text.length > 128) invalid(); continue; }
        if (!/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(text)) invalid();
        finishToken();
      }
      if (/[ \t\r\n]/u.test(character)) continue;
      if (finished) invalid();
      const frame = stack[stack.length - 1];
      if (character === '"') {
        keyToken = frame?.kind === "object" && (frame.expect === "key" || frame.expect === "keyOrEnd");
        target = keyToken ? undefined : beginValue();
        capture = keyToken ? stack.length === 1 : target !== undefined;
        text = capture ? '"' : ""; token = "string"; continue;
      }
      if (character === "{" || character === "[") {
        const topLevel = !root;
        if (topLevel && character !== "{") invalid();
        beginValue();
        if (stack.length >= 128) invalid();
        stack.push({ kind: character === "{" ? "object" : "array", expect: character === "{" ? "keyOrEnd" : "valueOrEnd" }); continue;
      }
      if (character === "}" || character === "]") {
        if (!frame || frame.kind !== (character === "}" ? "object" : "array") || !["commaOrEnd", character === "}" ? "keyOrEnd" : "valueOrEnd"].includes(frame.expect)) invalid();
        stack.pop(); if (!stack.length) finished = true; continue;
      }
      if (character === ":") { if (frame?.expect !== "colon") invalid(); frame.expect = "value"; continue; }
      if (character === ",") { if (frame?.expect !== "commaOrEnd") invalid(); frame.expect = frame.kind === "object" ? "key" : "value"; continue; }
      target = beginValue(); keyToken = false; capture = true; text = character; token = "primitive";
    }
  }
  if (!finished || token || stack.length) invalid();
  if (fields.title !== undefined && typeof fields.title !== "string") invalid();
  return normalizeNodeSession(fields, id);
}
