/** Windows 与 macOS 剪贴板图片摄取：仅读取显式粘贴事件，不后台轮询。 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWorkImage } from "@autopilot-agent/core";

/** 待发送的有界图片副本。 */
export interface CliDraftImage { name: string; mimeType: string; bytes: Uint8Array; gifFirstFrame?: boolean; }
const runFile = promisify(execFile);

/** 使用 STA 剪贴板读取文件列表或截图；普通文本作为文本返回。 */
export async function readWindowsClipboard(): Promise<{ images: CliDraftImage[]; text?: string }> {
  if (process.platform !== "win32") return { images: [] };
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
  @{ kind = 'files'; value = @([Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }) } | ConvertTo-Json -Compress
} elseif ([Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [Windows.Forms.Clipboard]::GetImage()
  $stream = New-Object IO.MemoryStream
  try { if (([long]$image.Width * [long]$image.Height) -gt 40000000) { throw 'IMAGE_TOO_LARGE' }; $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); if ($stream.Length -gt 20971520) { throw 'IMAGE_TOO_LARGE' }; @{ kind = 'image'; value = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress } finally { $stream.Dispose(); $image.Dispose() }
} elseif ([Windows.Forms.Clipboard]::ContainsText()) {
  @{ kind = 'text'; value = [Windows.Forms.Clipboard]::GetText() } | ConvertTo-Json -Compress
} else { @{ kind = 'empty'; value = '' } | ConvertTo-Json -Compress }`;
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { windowsHide: true, maxBuffer: 29 * 1024 * 1024, timeout: 15_000 });
  const payload = JSON.parse(stdout) as { kind: string; value: string | string[] };
  return normalizeClipboardPayload(payload);
}

/** 使用 macOS 自带的 JXA 和 AppKit 按需读取文件列表、位图或普通文本。 */
export async function readMacClipboard(): Promise<{ images: CliDraftImage[]; text?: string }> {
  if (process.platform !== "darwin") return { images: [] };
  const script = `ObjC.import('AppKit');
function exists(value) { var unwrapped = ObjC.unwrap(value); return unwrapped !== null && unwrapped !== undefined; }
function run() {
  var board = $.NSPasteboard.generalPasteboard;
  var urls = board.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey));
  if (exists(urls) && Number(urls.count) > 0) {
    if (Number(urls.count) > 10) throw new Error('TOO_MANY_IMAGES');
    var files = [];
    for (var i = 0; i < Number(urls.count); i++) files.push(ObjC.unwrap(urls.objectAtIndex(i).path));
    return JSON.stringify({kind: 'files', value: files});
  }
  var data = board.dataForType($.NSPasteboardTypePNG);
  if (!exists(data)) data = board.dataForType($.NSPasteboardTypeTIFF);
  if (exists(data)) {
    if (Number(data.length) > 20971520) throw new Error('IMAGE_TOO_LARGE');
    var rep = $.NSBitmapImageRep.imageRepWithData(data);
    if (!exists(rep) || Number(rep.pixelsWide) * Number(rep.pixelsHigh) > 40000000) throw new Error('IMAGE_TOO_LARGE');
    var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    if (!exists(png) || Number(png.length) > 20971520) throw new Error('IMAGE_TOO_LARGE');
    var text = board.stringForType($.NSPasteboardTypeString);
    return JSON.stringify({kind: 'image', value: ObjC.unwrap(png.base64EncodedStringWithOptions(0)), text: exists(text) ? ObjC.unwrap(text) : undefined});
  }
  var text = board.stringForType($.NSPasteboardTypeString);
  return JSON.stringify(exists(text) ? {kind: 'text', value: ObjC.unwrap(text)} : {kind: 'empty', value: ''});
}`;
  let payload: { kind?: unknown; value?: unknown; text?: unknown };
  try {
    const { stdout } = await runFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { maxBuffer: 29 * 1024 * 1024, timeout: 15_000 });
    payload = JSON.parse(stdout) as typeof payload;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    if (stderr.includes("TOO_MANY_IMAGES")) throw new Error("一次最多粘贴 10 张图片");
    if (stderr.includes("IMAGE_TOO_LARGE")) throw new Error("图片超过 20 MiB 输入上限");
    throw new Error("剪贴板图片读取或处理失败");
  }
  if (!payload || typeof payload !== "object" || (payload.text !== undefined && typeof payload.text !== "string")) throw new Error("剪贴板图片读取或处理失败");
  if (payload.kind === "image" && (typeof payload.value !== "string" || !payload.value.length || payload.value.length > 27_962_028 || payload.value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.value))) throw new Error("剪贴板图片读取或处理失败");
  if (payload.kind === "files" && (!Array.isArray(payload.value) || payload.value.some(function invalid(value) { return typeof value !== "string" || !value; }))) throw new Error("剪贴板图片读取或处理失败");
  if ((payload.kind === "text" || payload.kind === "empty") && typeof payload.value !== "string") throw new Error("剪贴板图片读取或处理失败");
  if (!["image", "files", "text", "empty"].includes(String(payload.kind))) throw new Error("剪贴板图片读取或处理失败");
  return normalizeClipboardPayload(payload as { kind: string; value: string | string[]; text?: string });
}

/** 复用同一有界文件读取和图片规范化，保持两平台的输入限制一致。 */
async function normalizeClipboardPayload(payload: { kind: string; value: string | string[]; text?: string }): Promise<{ images: CliDraftImage[]; text?: string }> {
  if (payload.kind === "text") return { images: [], text: typeof payload.value === "string" ? payload.value : "" };
  const candidates: Array<{ name: string; mimeType: string; bytes: Uint8Array }> = [];
  if (payload.kind === "image" && typeof payload.value === "string") candidates.push({ name: "clipboard.png", mimeType: "image/png", bytes: Buffer.from(payload.value, "base64") });
  if (payload.kind === "files") {
    const files = Array.isArray(payload.value) ? payload.value : [payload.value];
    if (files.length > 10) throw new Error("一次最多粘贴 10 张图片");
    for (const file of files) {
      const extension = path.extname(file).toLowerCase();
      const mimeType = extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "";
      if (!mimeType) throw new Error("剪贴板包含不支持的文件");
      const info = await stat(file);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("图片超过 20 MiB 输入上限");
      const bytes = await readFile(file);
      if (bytes.length !== info.size) throw new Error("图片读取失败");
      candidates.push({ name: path.basename(file), mimeType, bytes });
    }
  }
  const images: CliDraftImage[] = [];
  let total = 0;
  for (const candidate of candidates) {
    const normalized = await normalizeWorkImage(candidate);
    total += normalized.bytes.byteLength;
    if (total > 20 * 1024 * 1024) throw new Error("图片总大小超过 20 MiB");
    images.push({ name: candidate.name, mimeType: normalized.mimeType, bytes: normalized.bytes, gifFirstFrame: normalized.gifFirstFrame });
  }
  return { images, ...(typeof payload.text === "string" ? { text: payload.text } : {}) };
}
