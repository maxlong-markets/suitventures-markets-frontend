import "server-only";

import sharp from "sharp";

/**
 * The upload route's image steps (instant launchpad design, section 6, steps 7 to 9). The browser's type and size checks
 * are a courtesy; these are the rules. SVG and every other format are refused: an SVG is a document that can run script.
 */
export type ImageKind = "png" | "jpeg" | "gif" | "webp";
export type Reencoded = { ok: true; webp: Uint8Array<ArrayBuffer> } | { ok: false; code: "bad-image" | "unreadable-image" };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((value, i) => bytes[at + i] === value);
}
function ascii(bytes: Uint8Array, text: string, at = 0): boolean {
  return startsWith(bytes, [...text].map((c) => c.charCodeAt(0)), at);
}

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPEG)) return "jpeg";
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "gif";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "webp";
  return null;
}

/**
 * Step 8: sharp must read the same format the magic bytes claimed, or the file is refused. Step 9: one frame, rotated by
 * its EXIF orientation, centre-cropped to 512 x 512, re-encoded as WebP at quality 82. EXIF and anything appended after
 * the image's own end are gone, and an animated GIF becomes still.
 */
export async function reencodeImage(bytes: Uint8Array, kind: ImageKind): Promise<Reencoded> {
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    return { ok: false, code: "bad-image" };
  }
  if (format !== kind) return { ok: false, code: "bad-image" };
  try {
    const out = await sharp(bytes, { pages: 1, limitInputPixels: 50_000_000 })
      .rotate()
      .resize(512, 512, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
    return { ok: true, webp: new Uint8Array(out) };
  } catch {
    return { ok: false, code: "unreadable-image" };
  }
}
