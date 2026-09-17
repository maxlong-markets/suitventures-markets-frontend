import { describe, expect, it } from "vitest";
import { csvLine, csvValue } from "./csv";

describe("csvValue", () => {
  it("encodes null and undefined as an empty field, which COPY reads as NULL", () => {
    expect(csvValue(null)).toBe("");
    expect(csvValue(undefined)).toBe("");
  });
  it("encodes the empty string as a quoted empty field, which COPY reads as ''", () => {
    expect(csvValue("")).toBe('""');
  });
  it("leaves plain strings alone and quotes commas, quotes and line breaks", () => {
    expect(csvValue("0xabc")).toBe("0xabc");
    expect(csvValue("a,b")).toBe('"a,b"');
    expect(csvValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvValue("line\nbreak")).toBe('"line\nbreak"');
    expect(csvValue("cr\rhere")).toBe('"cr\rhere"');
  });
  it("encodes booleans as t and f", () => {
    expect(csvValue(true)).toBe("t");
    expect(csvValue(false)).toBe("f");
  });
  it("encodes numbers and bigints as decimal text", () => {
    expect(csvValue(42)).toBe("42");
    expect(csvValue(-0.5)).toBe("-0.5");
    expect(csvValue(10n ** 30n)).toBe("1000000000000000000000000000000");
  });
  it("refuses objects", () => {
    expect(() => csvValue({})).toThrow("csvValue");
    expect(() => csvValue(new Date(0))).toThrow("csvValue");
  });
});

describe("csvLine", () => {
  it("joins fields with commas and ends with a newline", () => {
    expect(csvLine([1, null, "x,y", true, ""])).toBe('1,,"x,y",t,""\n');
    expect(csvLine([])).toBe("\n");
  });
});
