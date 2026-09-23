import { createDb } from "@/lib/db/client";
import type { PairsScope } from "@/lib/envio/pairs";
import { createDbBackend } from "@/lib/market/dbBackend";
import { createEnvioBackend } from "@/lib/market/envioBackend";
import type { TokenPair } from "@/lib/types";

const TOLERANCE = 0.001; // 0.1 %
const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set in .env.local");
  process.exit(1);
}

function differs(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    // NaN compares unequal to everything, the ratio below included, so drift on either side must not read as parity.
    if (Number.isNaN(a) || Number.isNaN(b)) return true;
    if (a === b) return false;
    return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) > TOLERANCE;
  }
  return a !== b; // strings, booleans, null against a number
}

function report(scope: PairsScope, envio: TokenPair[], store: TokenPair[]): void {
  const e = new Map(envio.map((p) => [p.id, p]));
  const s = new Map(store.map((p) => [p.id, p]));
  const missingInStore = [...e.keys()].filter((id) => !s.has(id));
  const missingOnEnvio = [...s.keys()].filter((id) => !e.has(id));
  let fields = 0;
  for (const [id, a] of e) {
    const b = s.get(id);
    if (!b) continue;
    // The union of both sides' fields: one present on the store side only (logoUrl in practice) must show too.
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)] as (keyof TokenPair)[])) {
      if (!differs(a[key], b[key])) continue;
      fields += 1;
      console.log(`${scope} ${id} ${key}: envio=${String(a[key])} store=${String(b[key])}`);
    }
  }
  for (const id of missingInStore) console.log(`${scope} ${id}: missing in the store`);
  for (const id of missingOnEnvio) console.log(`${scope} ${id}: missing on Envio`);
  console.log(`${scope}: envio=${envio.length} store=${store.length} missingInStore=${missingInStore.length} missingOnEnvio=${missingOnEnvio.length} fieldDifferences=${fields}`);
}

const db = createDb(url, { max: 2 });
// No second argument any more: `DbBackendOpts.topHolders` — the only thing an EnvioSource was passed
// here for — went with the holders read-through on 23 Sep 2026, and this script compares `pairs()` only.
const store = createDbBackend(db);
const envio = createEnvioBackend();
try {
  for (const scope of ["all", "launchpad"] as const) {
    const [a, b] = await Promise.all([envio.pairs(scope), store.pairs(scope)]);
    report(scope, a, b);
  }
} finally {
  await db.end();
}
