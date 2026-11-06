/** 验证 Work 图片规范化和解码前资源边界。 */
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { normalizeWorkImage } from "../../src/internal/lib/image-normalization";

describe("Work 图片规范化", function imageNormalization() {
  it("合规图片保持原始字节", async function preservesSmallImage() {
    const bytes = createCanvas(4, 4).toBuffer("image/png");
    const result = await normalizeWorkImage({ bytes, mimeType: "image/png" });
    expect(Buffer.from(result.bytes)).toEqual(bytes);
    expect(result).toMatchObject({ width: 4, height: 4, mimeType: "image/png" });
  });

  it("超过编码目标的有效原图可生成有界副本", async function normalizesLargeInput() {
    const png = createCanvas(4, 4).toBuffer("image/png");
    const bytes = Buffer.concat([png, Buffer.alloc(3_932_161)]);
    const result = await normalizeWorkImage({ bytes, mimeType: "image/png" });
    expect(result.bytes.byteLength).toBeLessThanOrEqual(3_932_160);
    expect(Buffer.from(result.bytes).toString("base64").length).toBeLessThanOrEqual(5_242_880);
    expect(result).toMatchObject({ width: 4, height: 4, mimeType: "image/png" });
  });

  it("拒绝伪造类型与超过像素上限的头部", async function rejectsBadHeaders() {
    const png = createCanvas(4, 4).toBuffer("image/png");
    await expect(normalizeWorkImage({ bytes: png, mimeType: "image/jpeg" })).rejects.toThrow();
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(10_000, 16);
    bomb.writeUInt32BE(10_000, 20);
    await expect(normalizeWorkImage({ bytes: bomb })).rejects.toThrow();
    await expect(normalizeWorkImage({ bytes: Buffer.from("not an image") })).rejects.toThrow();
  });
});
