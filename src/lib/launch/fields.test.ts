import { describe, expect, it } from "vitest";
import { metadataJson, utf8Bytes, validateFields, type LaunchFields } from "./fields";

const OK: LaunchFields = { name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "" };
const check = (o: Partial<LaunchFields>) => validateFields({ ...OK, ...o });

describe("validateFields (instant launchpad design, section 6)", () => {
  it("counts the name and symbol in UTF-8 bytes, as the contract does: 8 rockets fit 32 bytes, 9 do not (Review Focus 1)", () => {
    expect(utf8Bytes("🚀")).toBe(4);
    expect(check({ name: "🚀".repeat(8) })).toMatchObject({ ok: true });
    expect(check({ name: "🚀".repeat(9) })).toEqual({ ok: false, field: "name" });
    expect(check({ name: "" })).toEqual({ ok: false, field: "name" });
    expect(check({ symbol: "🚀🚀" })).toMatchObject({ ok: true });
    expect(check({ symbol: "🚀🚀🚀" })).toEqual({ ok: false, field: "symbol" });
    expect(check({ symbol: "ABCDEFGHIJKL" })).toEqual({ ok: false, field: "symbol" });
    expect(check({ symbol: "" })).toEqual({ ok: false, field: "symbol" });
  });

  it("allows a description of 500 characters with newlines, and refuses 501 or any other control character", () => {
    expect(check({ description: "a".repeat(499) + "\n" })).toMatchObject({ ok: true });
    expect(check({ description: "é".repeat(500) })).toMatchObject({ ok: true }); // characters, not bytes
    expect(check({ description: "a".repeat(501) })).toEqual({ ok: false, field: "description" });
    expect(check({ description: "tab\there" })).toEqual({ ok: false, field: "description" });
    expect(check({ description: "cr\rhere" })).toEqual({ ok: false, field: "description" });
  });

  it("keeps a multipart CRLF as the newline typed, refuses a bare CR, and refuses C1 controls in the description", () => {
    expect(check({ description: "line one\r\nline two" })).toEqual({ ok: true, fields: { ...OK, description: "line one\nline two" } });
    expect(check({ description: "a".repeat(499) + "\r\n" })).toMatchObject({ ok: true }); // 500 once normalised
    expect(check({ description: "bare\rcr" })).toEqual({ ok: false, field: "description" });
    expect(check({ description: "c1\u0085here" })).toEqual({ ok: false, field: "description" });
    expect(check({ description: "c1\u009fhere" })).toEqual({ ok: false, field: "description" });
  });

  it("refuses spoofing characters in the name and symbol: controls, line breaks, bidi controls, zero-width characters", () => {
    const controls = ["\u0000", "\u0009", "\u001f", "\u007f", "\u0080", "\u009f"];
    const breaks = ["\n", "\r", "\r\n", "\u2028", "\u2029"];
    const bidi = ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c"];
    const zeroWidth = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"];
    for (const c of [...controls, ...breaks, ...bidi, ...zeroWidth]) {
      expect(check({ name: `Chalk${c}` })).toEqual({ ok: false, field: "name" });
      expect(check({ symbol: `CH${c}K` })).toEqual({ ok: false, field: "symbol" });
    }
    expect(check({ name: "Crème Chalk 🚀", symbol: "ÇHALK" })).toMatchObject({ ok: true });
  });

  it("takes an https website of at most 200 characters as typed, and refuses anything else", () => {
    expect(check({ website: "https://chalk.test/about" })).toMatchObject({ ok: true, fields: { website: "https://chalk.test/about" } });
    expect(check({ website: "http://chalk.test" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "chalk.test" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "https://chalk.test/" + "a".repeat(182) })).toEqual({ ok: false, field: "website" }); // 201 characters
  });

  it("refuses spoofing characters in the website, NUL and the right-to-left override among them, and stores the normalised URL", () => {
    expect(check({ website: "https://chalk.test/\u0000" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "https://chalk.test/‮gnp.exe" })).toEqual({ ok: false, field: "website" });
    for (const c of ["\u0009", "\n", "\r", "\u0085", " ", "​", "﻿", "⁦"]) {
      expect(check({ website: `https://chalk.test/a${c}b` })).toEqual({ ok: false, field: "website" });
      expect(check({ website: `https://chalk.test/a${c}` })).toEqual({ ok: false, field: "website" });
    }
    expect(check({ website: "https://Chalk.TEST" })).toMatchObject({ ok: true, fields: { website: "https://chalk.test/" } });
    expect(check({ website: "https://chalk.test/a b" })).toMatchObject({ ok: true, fields: { website: "https://chalk.test/a%20b" } });
  });

  it("never lets a spoofing character through the X or Telegram fields", () => {
    for (const c of ["\u0000", "\n", "‮", "​"]) {
      expect(check({ x: `chalk${c}` })).toEqual({ ok: false, field: "x" });
      expect(check({ x: `https://x.com/chalk${c}` })).toEqual({ ok: false, field: "x" });
      expect(check({ telegram: `chalky${c}` })).toEqual({ ok: false, field: "telegram" });
      expect(check({ telegram: `https://t.me/chalky${c}` })).toEqual({ ok: false, field: "telegram" });
    }
  });

  it("stores X as https://x.com/<handle> from a handle or an x.com or twitter.com profile URL", () => {
    const x = (value: string) => check({ x: value });
    expect(x("chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("@chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("https://x.com/chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("https://twitter.com/chalk_1/")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("https://www.x.com/chalk_1")).toMatchObject({ fields: { x: "https://x.com/chalk_1" } });
    expect(x("a_handle_far_too_long")).toEqual({ ok: false, field: "x" });
    expect(x("https://x.com/chalk/status/1")).toEqual({ ok: false, field: "x" });
    expect(x("https://evil.test/chalk")).toEqual({ ok: false, field: "x" });
  });

  it("stores Telegram as https://t.me/<name> from a 5 to 32 character name or a t.me URL", () => {
    const t = (value: string) => check({ telegram: value });
    expect(t("chalk")).toMatchObject({ fields: { telegram: "https://t.me/chalk" } });
    expect(t("https://t.me/chalk_group")).toMatchObject({ fields: { telegram: "https://t.me/chalk_group" } });
    expect(t("chal")).toEqual({ ok: false, field: "telegram" });
    expect(t("https://t.me/+invite")).toEqual({ ok: false, field: "telegram" });
  });

  it("reports the first failing field in form order", () => {
    expect(validateFields({ name: "", symbol: "", description: "", website: "nope", x: "", telegram: "" })).toEqual({ ok: false, field: "name" });
  });
});

describe("metadataJson (spec 6: Doppler and LONG compatible)", () => {
  it("writes the keys in order, no whitespace, empty strings kept", () => {
    const fields = { ...OK, description: "Chalk for tailors.", x: "https://x.com/chalk" };
    expect(new TextDecoder().decode(metadataJson(fields, "bafyimage"))).toBe(
      '{"name":"Tailor\'s Chalk","symbol":"CHALK","description":"Chalk for tailors.","image":"ipfs://bafyimage","website":"","x":"https://x.com/chalk","telegram":""}',
    );
  });
});
