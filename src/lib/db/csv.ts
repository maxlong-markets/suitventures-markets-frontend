/**
 * CSV for COPY … WITH (FORMAT csv). Postgres reads an unquoted empty field as NULL and a quoted
 * empty field as the empty string, which is why null and "" encode differently.
 */
const NEEDS_QUOTES = /[",\r\n]/;

/** RFC 4180 field: null/undefined → empty (COPY reads it as NULL); "" → ""; booleans → t/f; bigint/number → decimal text; strings quoted when they contain , " CR or LF, with " doubled. */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  switch (typeof v) {
    case "string":
      if (v === "") return '""';
      return NEEDS_QUOTES.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    case "boolean":
      return v ? "t" : "f";
    case "number":
    case "bigint":
      return String(v);
    default:
      throw new Error(`csvValue: cannot encode a ${typeof v}`);
  }
}

/** Fields joined by "," with a trailing "\n". */
export function csvLine(row: readonly unknown[]): string {
  return row.map(csvValue).join(",") + "\n";
}
