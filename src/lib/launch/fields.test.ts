import { describe, expect, it } from "vitest";
import {
  fieldIssues, fieldMessage, metadataJson, onChainText, utf8Bytes, validateFields, type FieldIssue, type LaunchFieldName, type LaunchFields,
} from "./fields";

const OK: LaunchFields = { name: "Tailor's Chalk", symbol: "CHALK", description: "", website: "", x: "", telegram: "" };
const check = (o: Partial<LaunchFields>) => validateFields({ ...OK, ...o });
const issues = (o: Partial<LaunchFields>) => fieldIssues({ ...OK, ...o });
/** Emoji joined into one picture by a zero-width joiner: technologist, rainbow flag (after U+FE0F), and one with a skin tone. */
const JOINED = ["\u{1F468}\u{200D}\u{1F4BB}", "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}", "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}"];

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

  // The name used to carry the character at its end (`Chalk${c}`). Since UX review item 7 the name is trimmed first, so a
  // tab, line break or U+FEFF at either end is removed rather than refused; inside the name every one is still refused.
  it("refuses spoofing characters in the name and symbol: controls, line breaks, bidi controls, zero-width characters", () => {
    const controls = ["\u0000", "\u0009", "\u001f", "\u007f", "\u0080", "\u009f"];
    const breaks = ["\n", "\r", "\r\n", "\u2028", "\u2029"];
    const bidi = ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c"];
    const zeroWidth = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"];
    for (const c of [...controls, ...breaks, ...bidi, ...zeroWidth]) {
      expect(check({ name: `Cha${c}lk` })).toEqual({ ok: false, field: "name" });
      expect(check({ symbol: `CH${c}K` })).toEqual({ ok: false, field: "symbol" });
    }
    // What trim() does not remove stays refused at the end too.
    for (const c of ["\x00", "\x7f", "\x85", "\u{200B}", "\u{202E}", "\u{2066}"]) {
      expect(check({ name: `Chalk${c}` })).toEqual({ ok: false, field: "name" });
    }
    expect(check({ name: "Crème Chalk 🚀", symbol: "ÇHALK" })).toMatchObject({ ok: true });
  });

  // UX review, should fix 7: a trailing space went on chain for good.
  it("trims the name and symbol before checking them, and hands them back trimmed for the metadata and the chain", () => {
    expect(onChainText("  Tailor's Chalk \t\n")).toBe("Tailor's Chalk");
    expect(check({ name: "  Tailor's Chalk  ", symbol: "\tCHALK \n" })).toEqual({ ok: true, fields: OK });
    expect(check({ name: ` ${"🚀".repeat(8)} ` })).toMatchObject({ ok: true, fields: { name: "🚀".repeat(8) } }); // 32 bytes once trimmed
    expect(check({ name: "   " })).toEqual({ ok: false, field: "name" });
    expect(check({ symbol: " \t " })).toEqual({ ok: false, field: "symbol" });
    expect(check({ name: "Tailor's  Chalk" })).toMatchObject({ ok: true, fields: { name: "Tailor's  Chalk" } }); // inside, kept as typed
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

describe("fieldIssues and fieldMessage (UX review, should fix 6): one sentence per field that says what to change", () => {
  it("names each field's own problem, every field at once, and nothing for a field that passes", () => {
    expect(fieldIssues(OK)).toEqual({});
    expect(
      fieldIssues({
        name: "🚀".repeat(9), symbol: "ABCDEFGHIJKL", description: "tab\there", website: "mysite.com", x: "https://x.com/chalk?s=21",
        telegram: "https://t.me/+invite",
      }),
    ).toEqual({ name: "too-long", symbol: "too-long", description: "control", website: "not-https", x: "query", telegram: "invite-link" });
  });

  it("agrees with validateFields, which the upload route runs: it names the first field in form order that has an issue", () => {
    const samples: Partial<LaunchFields>[] = [
      {}, { website: "mysite.com" }, { x: "x.com/chalk", telegram: "chal" }, { name: "Cha\tlk", website: "nope" }, { name: "  " },
      { description: "a".repeat(501), telegram: "https://t.me/+invite" },
    ];
    for (const s of samples) {
      const each = issues(s);
      const first = (["name", "symbol", "description", "website", "x", "telegram"] as const).find((f) => each[f] !== undefined);
      expect(check(s)).toMatchObject(first ? { ok: false, field: first } : { ok: true });
    }
  });

  it("tells the name and symbol apart: too long in bytes, a joined emoji, a hidden character, empty once trimmed", () => {
    expect(issues({ name: "🚀".repeat(9) }).name).toBe("too-long");
    for (const e of JOINED) {
      expect(issues({ name: `Dev ${e}` }).name).toBe("joined-emoji");
      expect(issues({ symbol: e }).symbol).toBe("joined-emoji");
    }
    expect(issues({ name: "Thumbs \u{1F44D}\u{1F3FD}", symbol: "\u{1F1FA}\u{1F1F8}" })).toEqual({}); // a skin tone and a flag join nothing
    expect(issues({ name: "Cha\tlk" }).name).toBe("hidden");
    expect(issues({ name: "Cha\u{200B}lk" }).name).toBe("hidden");
    expect(issues({ symbol: " " }).symbol).toBe("empty");
    // Fix round 1, ruling 11: the byte costs now include Chinese, Japanese and Korean characters (3 each).
    expect(fieldMessage("name", "too-long")).toBe(
      "Shorten the name to 32 bytes. A plain letter takes 1, an accented letter 2, a Chinese, Japanese or Korean character 3, an emoji 4.",
    );
    expect(fieldMessage("symbol", "too-long")).toBe(
      "Shorten the symbol to 11 bytes. A plain letter takes 1, an accented letter 2, a Chinese, Japanese or Korean character 3, an emoji 4.",
    );
    expect(utf8Bytes("\u{6F22}")).toBe(3); // the claim above, for a CJK character
    expect(fieldMessage("name", "joined-emoji")).toBe(`Joined emoji such as ${JOINED[0]} cannot go in the name. Use single emoji.`);
    expect(fieldMessage("name", "hidden")).toBe("The name holds a hidden character, such as a tab or line break. Type it again by hand.");
    expect(fieldMessage("symbol", "empty")).toBe("Enter a symbol.");
  });

  it("says what to change in the description and the website", () => {
    expect(issues({ description: "tab\there" }).description).toBe("control");
    expect(issues({ description: "a".repeat(501) }).description).toBe("too-long");
    expect(fieldMessage("description", "control")).toBe("The description holds a tab or a similar hidden character. Use spaces instead.");
    expect(fieldMessage("description", "too-long")).toBe("Shorten the description to 500 characters.");
    expect(issues({ website: "mysite.com" }).website).toBe("not-https");
    expect(issues({ website: "http://mysite.com" }).website).toBe("not-https");
    expect(issues({ website: "https://" }).website).toBe("bad-url");
    expect(issues({ website: `https://chalk.test/${"a".repeat(182)}` }).website).toBe("too-long");
    expect(issues({ website: "https://chalk.test/a\tb" }).website).toBe("hidden");
    expect(fieldMessage("website", "not-https")).toBe("The website must start with https://, as in https://example.com.");
  });

  it("says what to change in an X link: a share link's ? part, a post, a missing https://, a long handle, another site", () => {
    const x = (value: string) => issues({ x: value }).x;
    expect(x("https://x.com/chalk?s=21")).toBe("query");
    expect(x("https://x.com/chalk/status/1?s=21")).toBe("post-link");
    expect(x("x.com/chalk")).toBe("not-https");
    expect(x("a_handle_far_too_long")).toBe("bad-handle");
    expect(x("https://evil.test/chalk")).toBe("wrong-site");
    expect(x("@chalk ")).toBe("spaces");
    expect(x("chalk\x00")).toBe("hidden");
    expect(fieldMessage("x", "query")).toBe("Remove the ? and everything after it from the X link.");
    expect(fieldMessage("x", "post-link")).toBe("Use the profile link, like https://x.com/name, not a link to a post.");
  });

  it("says what to change in a Telegram link: an invite link, a ? part, a post, a short name", () => {
    const t = (value: string) => issues({ telegram: value }).telegram;
    expect(t("https://t.me/+invite")).toBe("invite-link");
    expect(t("t.me/joinchat/AbCdE")).toBe("invite-link");
    expect(t("https://t.me/chalk_group?start=1")).toBe("query");
    expect(t("https://t.me/chalk_group/12")).toBe("post-link");
    expect(t("chal")).toBe("bad-handle");
    expect(fieldMessage("telegram", "invite-link")).toBe("Invite links cannot be listed. Use a public group or channel, like https://t.me/name.");
    expect(fieldMessage("telegram", "bad-handle")).toBe("A Telegram name is 5 to 32 letters, digits or underscores.");
  });

  // Fix round 1, ruling 4: a phone capitalises the first letter of a plain input, so "https://" arrived as "Https://" and
  // was refused as if it did not start with https://. Scheme and host match without regard to case, here and in the route.
  it("takes a link's scheme and host in any letter case, and stores them in lower case", () => {
    expect(check({ website: "Https://MySite.com/About" })).toMatchObject({ ok: true, fields: { website: "https://mysite.com/About" } });
    expect(check({ x: "Https://X.com/Chalk_1" })).toMatchObject({ ok: true, fields: { x: "https://x.com/Chalk_1" } });
    expect(check({ x: "HTTPS://WWW.TWITTER.COM/chalk" })).toMatchObject({ ok: true, fields: { x: "https://x.com/chalk" } });
    expect(check({ telegram: "Https://T.me/chalk_group" })).toMatchObject({ ok: true, fields: { telegram: "https://t.me/chalk_group" } });
    // Without a scheme the rule still refuses them, and now says why rather than calling them another site.
    expect(issues({ x: "X.com/chalk" }).x).toBe("not-https");
    expect(issues({ telegram: "T.me/chalk_group" }).telegram).toBe("not-https");
    expect(issues({ website: "Http://mysite.com" }).website).toBe("not-https");
    expect(issues({ telegram: "HTTPS://T.ME/+invite" }).telegram).toBe("invite-link");
    expect(issues({ telegram: "https://t.me/JoinChat/AbCdE" }).telegram).toBe("invite-link");
  });

  // Fix round 1, ruling 11.
  it("names a # part apart from a ? part, and says 'link' for spaces in a pasted link", () => {
    expect(issues({ x: "https://x.com/chalk#top" }).x).toBe("fragment");
    expect(fieldMessage("x", "fragment")).toBe("Remove the # and everything after it from the X link.");
    expect(issues({ telegram: "https://t.me/chalk_group#about" }).telegram).toBe("fragment");
    expect(issues({ x: "https://x.com/chalk?s=21#top" }).x).toBe("query"); // removing from the ? takes the # part too
    expect(issues({ x: "https://x.com/ chalk" }).x).toBe("link-spaces");
    expect(fieldMessage("x", "link-spaces")).toBe("Remove the spaces from the X link.");
    expect(issues({ telegram: "t.me/chalk group" }).telegram).toBe("link-spaces");
    expect(fieldMessage("telegram", "link-spaces")).toBe("Remove the spaces from the Telegram link.");
    expect(issues({ x: "@chalk " }).x).toBe("spaces"); // a handle stays a handle
    expect(fieldMessage("x", "spaces")).toBe("Remove the spaces from the X handle.");
  });

  it("has a sentence of its own for every issue each field can report", () => {
    const table: Record<LaunchFieldName, FieldIssue[]> = {
      name: ["empty", "too-long", "joined-emoji", "hidden"],
      symbol: ["empty", "too-long", "joined-emoji", "hidden"],
      description: ["too-long", "control"],
      website: ["hidden", "not-https", "too-long", "bad-url"],
      x: ["hidden", "spaces", "link-spaces", "query", "fragment", "post-link", "not-https", "bad-handle", "wrong-site"],
      telegram: ["hidden", "spaces", "link-spaces", "invite-link", "query", "fragment", "post-link", "not-https", "bad-handle", "wrong-site"],
    };
    for (const [field, list] of Object.entries(table) as [LaunchFieldName, FieldIssue[]][]) {
      for (const issue of list) expect(fieldMessage(field, issue)).toMatch(/^(?!Check the )[A-Z].*\.$/);
    }
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
