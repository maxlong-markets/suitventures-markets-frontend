import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "./cache";
import { gql } from "./client";
import { loadPairs, PAIRS_LIMIT } from "./pairs";
import { PAIRS_QUERY, PAIRS_RECOVERY_QUERY, type PoolRow, type QuotePriceRow, type TokenRow } from "./queries";

vi.mock("./client", () => ({ gql: vi.fn() }));

const QUOTE_A = `0x${"a".repeat(40)}`;
const QUOTE_B = `0x${"b".repeat(40)}`;
const tokenId = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const poolId = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
/** A pool parked at a tick boundary: what the indexer hands back as `primaryPool` for 1000+ tokens. */
const BROKEN = { priceQuote: "3.4e50" } satisfies Partial<PoolRow>;

function pool(n: number, over: Partial<PoolRow> = {}): PoolRow {
  return {
    id: poolId(n), quote_id: QUOTE_A, tokenIsCurrency0: true, hooks: tokenId(0), fee: 3000, tickSpacing: 60,
    origin: "LONG", createdAt: 1, priceQuote: "2", tvlToken: null, tvlQuote: null,
    swapCount: 10, lastSwapAt: 1_000_000, quote: { symbol: "QA", decimals: 18 }, ...over,
  };
}

function token(n: number, over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: tokenId(n), address: tokenId(n), symbol: `T${n}`, name: `T${n}`, decimals: 18,
    totalSupply: "1000000000000000000", holdersCount: 1, origin: "LONG", createdAt: 1,
    primaryPool: pool(n), ...over,
  };
}

// `pinned` is never stale, so these prices stay usable whatever the clock says.
const price = (id: string, usdPrice: string): QuotePriceRow => ({ id, usdPrice, updatedAt: 0, aggregator: "pinned" });

type Rows = { Token: TokenRow[]; QuotePrice: QuotePriceRow[] };
let recoveryVars: Record<string, unknown> | undefined;

function stub(main: Rows, recovery: Rows) {
  recoveryVars = undefined;
  vi.mocked(gql).mockImplementation(async (query, variables) => {
    if (query === PAIRS_QUERY) return main as never;
    if (query === PAIRS_RECOVERY_QUERY) {
      recoveryVars = variables;
      return recovery as never;
    }
    if (query.startsWith("query Window")) return {} as never; // no candles: changes null, vol24h 0
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  });
}

const onlyA = [price(QUOTE_A, "1")];

describe("loadPairs merge", () => {
  beforeEach(() => {
    clearTtlCache(); // loadPairs memoises per scope, so every case must start cold
    vi.mocked(gql).mockReset();
  });

  it("keeps the main row when a token is in both result sets", async () => {
    // The recovery set can carry the same token with its broken primary; the main row is authoritative.
    const recovered = token(1, { primaryPool: pool(99, BROKEN), fallbackPool: [pool(98)] });
    stub({ Token: [token(1)], QuotePrice: onlyA }, { Token: [recovered], QuotePrice: onlyA });
    const out = await loadPairs();
    expect(out.map((p) => p.id)).toEqual([tokenId(1)]);
    expect(out[0]!.poolId).toBe(poolId(1));
  });

  it("ranks a recovered row above a main row when its resolved pool traded more recently", async () => {
    const mainRow = token(1, { primaryPool: pool(1, { lastSwapAt: 1_000 }) });
    const recovered = token(2, {
      primaryPool: pool(99, { ...BROKEN, lastSwapAt: 1 }),
      fallbackPool: [pool(2, { lastSwapAt: 5_000 })],
    });
    stub({ Token: [mainRow], QuotePrice: onlyA }, { Token: [recovered], QuotePrice: onlyA });
    const out = await loadPairs();
    // Sorting on the broken primary's lastSwapAt would have put token 2 last.
    expect(out.map((p) => p.id)).toEqual([tokenId(2), tokenId(1)]);
    expect(out[0]!.poolId).toBe(poolId(2));
  });

  it("drops a token whose primary is broken and has no sane fallback", async () => {
    const hopeless = token(3, { primaryPool: pool(97, BROKEN) });
    const brokenFallback = token(4, { primaryPool: pool(96, BROKEN), fallbackPool: [pool(95, BROKEN)] });
    stub({ Token: [token(1)], QuotePrice: onlyA }, { Token: [hopeless, brokenFallback], QuotePrice: onlyA });
    const out = await loadPairs();
    expect(out.map((p) => p.id)).toEqual([tokenId(1)]);
  });

  it("caps the merged list at PAIRS_LIMIT, newest resolved swap first", async () => {
    const main = Array.from({ length: PAIRS_LIMIT }, (_, i) => token(i + 1, { primaryPool: pool(i + 1, { lastSwapAt: 2_000_000 - i }) }));
    const recovery = Array.from({ length: 10 }, (_, i) => token(9_000 + i, {
      primaryPool: pool(8_000 + i, BROKEN),
      fallbackPool: [pool(9_000 + i, { lastSwapAt: 9_000_000 - i })],
    }));
    stub({ Token: main, QuotePrice: onlyA }, { Token: recovery, QuotePrice: onlyA });
    const out = await loadPairs();
    expect(out).toHaveLength(PAIRS_LIMIT);
    // The ten recovered rows are the newest, so they lead and the ten oldest main rows fall off.
    expect(out.slice(0, 10).map((p) => p.id)).toEqual(recovery.map((t) => t.id));
    expect(out.map((p) => p.id)).not.toContain(main[PAIRS_LIMIT - 1]!.id);
  });

  it("unions the two QuotePrice arrays and tolerates the duplicate ids", async () => {
    const mainRow = token(1, { primaryPool: pool(1, { quote_id: QUOTE_A, priceQuote: "3" }) });
    const recovered = token(2, {
      primaryPool: pool(99, BROKEN),
      fallbackPool: [pool(2, { quote_id: QUOTE_B, priceQuote: "4", lastSwapAt: 1 })],
    });
    stub(
      { Token: [mainRow], QuotePrice: [price(QUOTE_A, "2")] },
      { Token: [recovered], QuotePrice: [price(QUOTE_A, "2"), price(QUOTE_B, "5")] },
    );
    const out = await loadPairs();
    const byId = new Map(out.map((p) => [p.id, p]));
    expect(byId.get(tokenId(1))!.priceUsd).toBeCloseTo(3 * 2, 9); // main-only quote still priced
    expect(byId.get(tokenId(2))!.priceUsd).toBeCloseTo(4 * 5, 9); // recovery-only quote reached usdMap
    expect(out.every((p) => p.stale === false)).toBe(true);
  });

  it("cuts recovery at the main list's oldest swap once the main list is full", async () => {
    const main = Array.from({ length: PAIRS_LIMIT }, (_, i) => token(i + 1, { primaryPool: pool(i + 1, { lastSwapAt: 2_000_000 - i }) }));
    stub({ Token: main, QuotePrice: onlyA }, { Token: [], QuotePrice: [] });
    await loadPairs();
    expect(recoveryVars).toEqual({ since: 2_000_000 - (PAIRS_LIMIT - 1), limit: 1_000 });
  });

  it("falls back to a seven day window when the main list is short", async () => {
    stub({ Token: [token(1)], QuotePrice: onlyA }, { Token: [], QuotePrice: [] });
    await loadPairs();
    const expected = Math.floor(Date.now() / 1000) - 7 * 86400;
    expect(recoveryVars!.limit).toBe(1_000);
    expect(recoveryVars!.since as number).toBeGreaterThanOrEqual(expected - 2);
    expect(recoveryVars!.since as number).toBeLessThanOrEqual(expected + 2);
  });
});
