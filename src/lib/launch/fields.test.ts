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

  it("takes an https website of at most 200 characters as typed, and refuses anything else", () => {
    expect(check({ website: "https://chalk.test/about" })).toMatchObject({ ok: true, fields: { website: "https://chalk.test/about" } });
    expect(check({ website: "http://chalk.test" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "chalk.test" })).toEqual({ ok: false, field: "website" });
    expect(check({ website: "https://chalk.test/" + "a".repeat(182) })).toEqual({ ok: false, field: "website" }); // 201 characters
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
