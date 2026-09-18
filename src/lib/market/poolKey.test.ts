import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { gql } from "@/lib/envio/client";
import { POOL_KEY_QUERY, type PoolKeyPoolRow } from "@/lib/envio/queries";
import { FakeSource } from "@/lib/sync/fakeSource";
import type { PoolRec, QuoteRec, TokenRec } from "@/lib/sync/source";
import { upsertPools, upsertQuotes, upsertTokens } from "@/lib/sync/writers";
import { testDb } from "@/test/db";
import { createDbBackend } from "./dbBackend";
import { createEnvioBackend } from "./envioBackend";
import { poolKeyRow, type PoolKeyParts } from "./poolKey";

// EnvioUnavailableError is re-exported because _lib/respond imports it from the same module
// (mirrors envioBackend.test.ts's own mock of this module).
vi.mock("@/lib/envio/client", () => ({ gql: vi.fn(), EnvioUnavailableError: class EnvioUnavailableError extends Error {} }));
const gqlMock = vi.mocked(gql);

/**
 * The real AI/NVDA pool, in the indexer's own casing: ids lowercase, `Token.address` and
 * `Quote.address` checksummed. These are the fixtures' constants, and the only pool key that
 * hashes to this pool id — see the header's verified facts.
 */
const parts: PoolKeyParts = {
  poolId: "0xCBDFEA90430A30EE4469C9902E120A77E7C7E4711D5643671C1D1957F2F1CE27",
  hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544",
  fee: 8388608,
  tickSpacing: 8,
  tokenIsCurrency0: true,
  priceQuote: 0.000866,
  tokenAddress: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18",
  tokenDecimals: 18,
  quoteAddress: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  quoteDecimals: 18,
};
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

describe("poolKeyRow", () => {
  it("lowercases every address, so a row from the store equals a row from the indexer", () => {
    expect(poolKeyRow(parts)).toEqual({
      poolId: "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27",
      currency0: AI,
      currency1: NVDA,
      fee: 8388608,
      tickSpacing: 8,
      hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
      tokenIsCurrency0: true,
      priceQuote: 0.000866,
      tokenAddress: AI,
      tokenDecimals: 18,
      quoteAddress: NVDA,
      quoteDecimals: 18,
    });
  });

  it("orders the currencies by the flag the pool was created with, never by a string comparison", () => {
    expect(poolKeyRow({ ...parts, tokenIsCurrency0: false })).toMatchObject({
      currency0: NVDA,
      currency1: AI,
      tokenIsCurrency0: false,
      tokenAddress: AI,
      quoteAddress: NVDA,
    });
  });

  it("carries the fields the chain never sees: the stored price and both decimals", () => {
    const row = poolKeyRow({ ...parts, priceQuote: 0.5, tokenDecimals: 8, quoteDecimals: 6 });
    expect(row).toMatchObject({ priceQuote: 0.5, tokenDecimals: 8, quoteDecimals: 6 });
  });
});

/**
 * `poolKeyRow()` above only proves the builder is consistent; it says nothing about the *rule* that
 * feeds it — MarketBackend.poolKey, one rule the db and envio backends must implement the same way
 * (review I3). This feeds identical token/pool data to both — db rows through PGlite, envio rows
 * through a fake `gql` response — across the three cases that rule exists to decide, and checks
 * they land on the same pool. Only the client-side choice between a pool's primary and its fallback
 * slot can be pinned this way; the fallback's own ordering is the indexer's `order_by`, which a
 * mocked `gql` cannot exercise (see envioBackend.test.ts for that half).
 */
describe("poolKey parity: db and envio agree on the trading pool for the same data", () => {
  const addr = (c: string) => `0x${c.repeat(40)}`;
  const poolId = (c: string) => `0x${c.repeat(64)}`;
  const NOW = 1_800_000_000;
  const QUOTE = addr("9");
  const HOOKS = addr("0");
  const SANE = 0.000866;
  const INSANE = 3.4e50;
  const FEE = 3000;
  const TICK_SPACING = 60;
  const DECIMALS = 18;
  const QUOTE_DECIMALS = 6;

  type Candidate = { id: string; priceQuote: number; swapCount: number; lastSwapAt: number | null };
  type Scenario = { name: string; token: string; primary: Candidate; others: Candidate[]; fallbackWinner: Candidate; winner: string };

  const scenarios: Scenario[] = [
    {
      name: "no sane primary, two sane candidates: the higher swap count wins",
      token: addr("p"),
      primary: { id: poolId("p"), priceQuote: INSANE, swapCount: 0, lastSwapAt: null },
      others: [
        { id: poolId("q"), priceQuote: SANE, swapCount: 4, lastSwapAt: NOW - 500 },
        { id: poolId("r"), priceQuote: SANE, swapCount: 9, lastSwapAt: NOW - 200 },
      ],
      fallbackWinner: { id: poolId("r"), priceQuote: SANE, swapCount: 9, lastSwapAt: NOW - 200 },
      winner: poolId("r"),
    },
    {
      name: "no sane primary, a swap-count tie: the lower pool id wins",
      token: addr("s"),
      primary: { id: poolId("s"), priceQuote: INSANE, swapCount: 0, lastSwapAt: null },
      others: [
        { id: poolId("t"), priceQuote: SANE, swapCount: 6, lastSwapAt: NOW - 500 },
        { id: poolId("u"), priceQuote: SANE, swapCount: 6, lastSwapAt: NOW - 200 },
      ],
      fallbackWinner: { id: poolId("t"), priceQuote: SANE, swapCount: 6, lastSwapAt: NOW - 500 },
      winner: poolId("t"),
    },
    {
      name: "a sane, never-swapped primary beats a different pool that has traded heavily",
      token: addr("v"),
      primary: { id: poolId("v"), priceQuote: SANE, swapCount: 0, lastSwapAt: null },
      others: [{ id: poolId("w"), priceQuote: SANE, swapCount: 50, lastSwapAt: NOW - 100 }],
      fallbackWinner: { id: poolId("w"), priceQuote: SANE, swapCount: 50, lastSwapAt: NOW - 100 },
      winner: poolId("v"),
    },
  ];

  function poolRec(c: Candidate, tokenId: string): PoolRec {
    return {
      id: c.id, token_id: tokenId, quote_id: QUOTE, tokenIsCurrency0: true, hooks: HOOKS, fee: FEE, tickSpacing: TICK_SPACING,
      origin: "LONG", createdAt: NOW - 10_000, priceQuote: c.priceQuote, tvlToken: null, tvlQuote: null,
      swapCount: c.swapCount, lastSwapAt: c.lastSwapAt, volumeQuoteAllTime: "0",
    };
  }
  function tokenRec(s: Scenario): TokenRec {
    return {
      id: s.token, address: s.token, symbol: "PAR", name: "Parity token", decimals: DECIMALS,
      totalSupply: "1000000000000000000000000000", holdersCount: 1, poolCount: 1 + s.others.length,
      origin: "LONG", createdAt: NOW - 10_000, primaryPool_id: s.primary.id, metadataLoaded: true,
    };
  }
  function poolKeyPoolRow(c: Candidate): PoolKeyPoolRow {
    return {
      id: c.id, quote_id: QUOTE, tokenIsCurrency0: true, hooks: HOOKS, fee: FEE, tickSpacing: TICK_SPACING,
      priceQuote: c.priceQuote, quote: { address: QUOTE, decimals: QUOTE_DECIMALS },
    };
  }

  let db: Db;
  beforeAll(async () => {
    db = await testDb();
    const quote: QuoteRec = { id: QUOTE, address: QUOTE, symbol: "QT", name: "Quote asset", decimals: QUOTE_DECIMALS, enabled: true };
    await upsertQuotes(db, [quote], []);
    await upsertTokens(db, scenarios.map(tokenRec), NOW);
    await upsertPools(db, scenarios.flatMap((s) => [s.primary, ...s.others].map((c) => poolRec(c, s.token))), NOW);
  });
  afterAll(() => db.end());
  // A concise-body arrow here would return mockReset()'s own result (the mock itself, for
  // chaining) — and Vitest treats a function returned from beforeEach as a cleanup hook, so it
  // would call the mock a second time, as "cleanup", with no arguments. The block body discards it.
  beforeEach(() => {
    gqlMock.mockReset();
  });

  it("feeds the same token/pool data to both backends and gets the same poolId back, in all three scenarios", async () => {
    const db_ = createDbBackend(db, new FakeSource({}), () => NOW);
    const envio = createEnvioBackend();
    for (const s of scenarios) {
      gqlMock.mockImplementation(async (query) => {
        if (query === POOL_KEY_QUERY) {
          return {
            Token: [{
              id: s.token, address: s.token, decimals: DECIMALS,
              primaryPool: poolKeyPoolRow(s.primary),
              fallbackPool: [poolKeyPoolRow(s.fallbackWinner)],
            }],
          } as never;
        }
        throw new Error(`unexpected query ${query.slice(0, 30)}`);
      });
      const fromDb = await db_.poolKey(s.token);
      const fromEnvio = await envio.poolKey(s.token);
      expect(fromDb?.poolId, s.name).toBe(s.winner);
      expect(fromEnvio?.poolId, s.name).toBe(s.winner);
      expect(fromDb, s.name).toEqual(fromEnvio);
    }
  });
});
