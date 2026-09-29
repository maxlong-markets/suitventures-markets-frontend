import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { reencodeImage, sniffImage } from "./image";

let png: Buffer;
let jpeg: Buffer;
let gif: Buffer;
let webp: Buffer;
let animated: Buffer;
beforeAll(async () => {
  const square = (background: string) => sharp({ create: { width: 64, height: 48, channels: 3, background } });
  png = await square("#00ff00").png().toBuffer();
  jpeg = await square("#ff0000").jpeg().toBuffer();
  gif = await square("#0000ff").gif().toBuffer();
  webp = await square("#ffff00").webp().toBuffer();
  const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#0000ff" } }).png().toBuffer();
  animated = await sharp([red, blue], { join: { animated: true } }).gif().toBuffer();
});

describe("sniffImage (spec 6 step 7)", () => {
  it("recognises PNG, JPEG, GIF and WebP by their first bytes, and nothing else", () => {
    expect([sniffImage(png), sniffImage(jpeg), sniffImage(gif), sniffImage(webp)]).toEqual(["png", "jpeg", "gif", "webp"]);
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("RIFF0000WAVE"))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe("reencodeImage (spec 6 steps 8 and 9)", () => {
  it("turns each accepted type into one 512 x 512 WebP", async () => {
    for (const [bytes, kind] of [[png, "png"], [jpeg, "jpeg"], [gif, "gif"], [webp, "webp"]] as const) {
      const out = await reencodeImage(bytes, kind);
      if (!out.ok) throw new Error(`${kind} was refused`);
      const meta = await sharp(out.webp).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", 512, 512]);
    }
  });

  it("keeps one frame of an animated GIF", async () => {
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
    const out = await reencodeImage(animated, "gif");
    if (!out.ok) throw new Error("refused");
    expect((await sharp(out.webp, { pages: -1 }).metadata()).pages ?? 1).toBe(1);
  });

  it("drops anything appended after the image's own end", async () => {
    const payload = new TextEncoder().encode("PAYLOAD-AFTER-THE-END");
    const out = await reencodeImage(Buffer.concat([png, payload]), "png");
    if (!out.ok) throw new Error("refused");
    expect(Buffer.from(out.webp).includes(Buffer.from(payload))).toBe(false);
  });

  it("refuses a file whose magic bytes disagree with its real format, and one it cannot decode", async () => {
    const disguised = Buffer.concat([png.subarray(0, 8), jpeg]); // PNG magic, JPEG body
    expect(sniffImage(disguised)).toBe("png");
    expect(await reencodeImage(disguised, "png")).toEqual({ ok: false, code: "bad-image" });
    expect(await reencodeImage(jpeg, "png")).toEqual({ ok: false, code: "bad-image" }); // decodes, but as a JPEG
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#00ff00" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await reencodeImage(huge, "png")).toEqual({ ok: false, code: "unreadable-image" }); // 64 million pixels, over the 50 million limit
  });
});
