/**
 * Writes the launchpad's deploy config (instant launchpad design, section 8.3) from src/lib/chain/math/config/quotes.json.
 *
 *   npm run launch:currencies -- --out ../SuitVenturesMarket-contracts/script/config/launch-currencies.json
 *
 * Run once. It refuses to overwrite an existing file unless --force is given, because Kobe fills the 29 reference
 * prices into that file by hand and a second run must never wipe them. Reads no environment and touches no network.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QUOTES } from "@/lib/chain/math/quotes";
import { currencyConfig } from "@/lib/launch/currencyConfig";

function parseArgs(argv: readonly string[]): { out: string; force: boolean } {
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : undefined;
  if (!out) throw new Error("usage: npm run launch:currencies -- --out <path> [--force]");
  return { out: resolve(out), force: argv.includes("--force") };
}

const { out, force } = parseArgs(process.argv.slice(2));
if (existsSync(out) && !force) {
  console.error(`${out} already exists; pass --force to overwrite it (the reference prices in it would be lost)`);
  process.exit(1);
}
const file = currencyConfig(QUOTES);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
const count = (source: string) => file.currencies.filter((c) => c.priceSource === source).length;
console.log(`wrote ${file.currencies.length} currencies to ${out}: ${count("chainlink")} on a feed, ${count("pinned")} pinned, ${count("reference")} waiting for a reference price`);
