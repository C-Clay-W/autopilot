/** 会话图片上传校验真实字节与声明大小，拒绝伪装文件。 */
import { describe, expect, it, vi } from "vitest";
import { storeSessionImage } from "@/lib/session-attachment-store";

describe("Work 图片上传校验", function imageValidation() {
  it("拒绝扩展名与实际字节不一致的图片", async function rejectsForgedImage() {
    await expect(storeSessionImage("00000000-0000-0000-0000-000000000000", new File(["not png"], "image.png", { type: "image/png" }))).rejects.toMatchObject({ code: "WORK_ATTACHMENT_INVALID" });
  });

  it("拒绝实际长度与声明长度不一致", async function rejectsMismatchedSize() {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = { name: "image.png", type: "image/png", size: 1, arrayBuffer: vi.fn(async function read() { return bytes.buffer; }) };
    await expect(storeSessionImage("00000000-0000-0000-0000-000000000000", file)).rejects.toMatchObject({ code: "WORK_ATTACHMENT_INVALID" });
  });

  it("拒绝超过原图输入上限的新图片", async function rejectsOversizedImage() {
    const file = { name: "image.png", type: "image/png", size: 20 * 1024 * 1024 + 1, arrayBuffer: vi.fn() };
    await expect(storeSessionImage("00000000-0000-0000-0000-000000000000", file)).rejects.toMatchObject({ code: "WORK_ATTACHMENT_INVALID" });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });
});
