import { EnvioUnavailableError, gql as defaultGql } from "@/lib/envio/client";
import { createLimiter, withRetry, type Limiter, type RetryOpts } from "./limiter";
import type { BalanceRec, CandleRec, EnvioSource, PoolRec, QuotePriceRec, QuoteRec, SwapRec, TokenRec } from "./source";

const CHAIN_ID = 4663;
/** No lower bound: every key is greater than -1 and every id greater than "". */
const FIRST_PAGE = { k: -1, kid: "" };

const QUOTE_FIELDS = "id address symbol name decimals enabled";
const QUOTE_PRICE_FIELDS = "id usdPrice updatedAt aggregator";
const POOL_FIELDS = "id token_id quote_id tokenIsCurrency0 hooks fee tickSpacing origin createdAt priceQuote tvlToken tvlQuote swapCount lastSwapAt volumeQuoteAllTime sqrtPriceX96";
const TOKEN_FIELDS = "id address symbol name decimals totalSupply holdersCount poolCount origin createdAt primaryPool_id metadataLoaded";
const SWAP_FIELDS = "id pool_id token_id timestamp side amountToken amountQuote priceQuote wallet txHash";
const CANDLE_FIELDS = "id pool_id t open high low close volumeQuote volumeToken trades";
const BALANCE_FIELDS = "id token_id holder balance updatedAt";

/** Hasura two-column keyset: rows strictly after ($k, $kid) in (col, id) order. */
const keyset = (col: string) => `{ _or: [ { ${col}: { _gt: $k } }, { ${col}: { _eq: $k }, id: { _gt: $kid } } ] }`;
const ordered = (col: string) => `order_by: [ { ${col}: asc }, { id: asc } ], limit: $limit`;

const QUOTES = `query SyncQuotes { Quote { ${QUOTE_FIELDS} } QuotePrice { ${QUOTE_PRICE_FIELDS} } }`;
const POOLS_SINCE = `query SyncPoolsSince($since: Int!, $k: Int!, $kid: String!, $limit: Int!) {
  Pool(where: { _and: [ { lastSwapAt: { _gte: $since } }, ${keyset("lastSwapAt")} ] }, ${ordered("lastSwapAt")}) { ${POOL_FIELDS} }
}`;
const POOLS_CREATED_SINCE = `query SyncPoolsCreatedSince($since: Int!, $k: Int!, $kid: String!, $limit: Int!) {
  Pool(where: { _and: [ { createdAt: { _gte: $since } }, { lastSwapAt: { _is_null: true } }, ${keyset("createdAt")} ] }, ${ordered("createdAt")}) { ${POOL_FIELDS} }
}`;
const SWAPS_FOR = `query SyncSwapsFor($pools: [String!]!, $since: Int!, $k: Int!, $kid: String!, $limit: Int!) {
  Swap(where: { _and: [ { pool_id: { _in: $pools } }, { timestamp: { _gte: $since } }, ${keyset("timestamp")} ] }, ${ordered("timestamp")}) { ${SWAP_FIELDS} }
}`;
const RECENT_CANDLES = `recent: Candle(where: { _and: [ { pool_id: { _in: $pools } }, { t: { _gte: $since } }, ${keyset("t")} ] }, ${ordered("t")}) { ${CANDLE_FIELDS} }`;
const CANDLES_FIRST = `query SyncCandlesFirst($pools: [String!]!, $since: Int!, $k: Int!, $kid: String!, $limit: Int!, $openIds: [String!]!) {
  ${RECENT_CANDLES}
  open: Candle(where: { id: { _in: $openIds } }) { ${CANDLE_FIELDS} }
}`;
const CANDLES_NEXT = `query SyncCandlesNext($pools: [String!]!, $since: Int!, $k: Int!, $kid: String!, $limit: Int!) { ${RECENT_CANDLES} }`;
const TOKENS_BY_ID = `query SyncTokensById($ids: [String!]!) { Token(where: { id: { _in: $ids } }) { ${TOKEN_FIELDS} } }`;
const TOP_HOLDERS = `query SyncTopHolders($token: String!, $limit: Int!) {
  TokenBalance(where: { token_id: { _eq: $token }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: $limit) { ${BALANCE_FIELDS} }
}`;
/**
 * One request for up to n tokens: an aliased TokenBalance selection per token (t0, t1, …), each with its own
 * `$t0`, `$t1`, … variable so no id is ever interpolated into the document, all sharing one `$limit`.
 */
function topHoldersBatchDoc(n: number): string {
  const vars = Array.from({ length: n }, (_, i) => `$t${i}: String!`).join(", ");
  const selections = Array.from(
    { length: n },
    (_, i) => `t${i}: TokenBalance(where: { token_id: { _eq: $t${i} }, balance: { _gt: "0" } }, order_by: { balance: desc }, limit: $limit) { ${BALANCE_FIELDS} }`,
  ).join("\n  ");
  return `query SyncTopHoldersBatch(${vars}, $limit: Int!) {\n  ${selections}\n}`;
}
const CHAIN_META = "query SyncChainMeta { chain_metadata { chain_id latest_processed_block block_height } }";

/** Id-range walk: id > $after (and < $before when bounded), ascending, `extra` appended inside the where object. */
function pageDoc(entity: string, fields: string, bounded: boolean, extra = ""): string {
  const vars = bounded ? "$after: String!, $before: String!, $limit: Int!" : "$after: String!, $limit: Int!";
  const range = bounded ? "id: { _gt: $after, _lt: $before }" : "id: { _gt: $after }";
  return `query Sync${entity}Page(${vars}) { ${entity}(where: { ${range}${extra} }, order_by: { id: asc }, limit: $limit) { ${fields} } }`;
}
const PAGES = {
  Token: [pageDoc("Token", TOKEN_FIELDS, false), pageDoc("Token", TOKEN_FIELDS, true)],
  Pool: [pageDoc("Pool", POOL_FIELDS, false), pageDoc("Pool", POOL_FIELDS, true)],
  Swap: [pageDoc("Swap", SWAP_FIELDS, false), pageDoc("Swap", SWAP_FIELDS, true)],
  Candle: [pageDoc("Candle", CANDLE_FIELDS, false), pageDoc("Candle", CANDLE_FIELDS, true)],
} as const;

type ChainRow = { chain_id: number; latest_processed_block: number; block_height: number };

/**
 * Real source over the M1 `gql` client. Every request first awaits `limiter.take()` (default: 200 a minute) and runs
 * through `withRetry`: with its defaults when `retry` is true or absent, with the given RetryOpts, or not at all when
 * `retry` is false. `gql` is injectable so tests can capture documents and variables.
 */
export function createEnvioSource(opts: { gql?: typeof defaultGql; limiter?: Limiter; retry?: RetryOpts | boolean } = {}): EnvioSource {
  const gql = opts.gql ?? defaultGql;
  const limiter = opts.limiter ?? createLimiter(200);
  const retry = opts.retry ?? true;
  let queries = 0;

  async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Each attempt is a request the indexer sees: it takes a token and counts.
    const once = async () => {
      await limiter.take();
      queries += 1;
      return gql<T>(query, variables);
    };
    return retry === false ? once() : withRetry(once, retry === true ? {} : retry);
  }

  async function page<E extends keyof typeof PAGES, T>(entity: E, afterId: string, beforeId: string | null, limit: number): Promise<T[]> {
    const [unbounded, bounded] = PAGES[entity];
    const data = beforeId === null
      ? await request<Record<E, T[]>>(unbounded, { after: afterId, limit })
      : await request<Record<E, T[]>>(bounded, { after: afterId, before: beforeId, limit });
    return data[entity];
  }

  return {
    get queries() {
      return queries;
    },
    async quotes() {
      const d = await request<{ Quote: QuoteRec[]; QuotePrice: QuotePriceRec[] }>(QUOTES, {});
      return { quotes: d.Quote, prices: d.QuotePrice };
    },
    async poolsSince(since, after, limit) {
      const key = after ? { k: after.lastSwapAt, kid: after.id } : FIRST_PAGE;
      return (await request<{ Pool: PoolRec[] }>(POOLS_SINCE, { since, limit, ...key })).Pool;
    },
    async poolsCreatedSince(since, after, limit) {
      const key = after ? { k: after.createdAt, kid: after.id } : FIRST_PAGE;
      return (await request<{ Pool: PoolRec[] }>(POOLS_CREATED_SINCE, { since, limit, ...key })).Pool;
    },
    async swapsFor(poolIds, since, after, limit) {
      if (poolIds.length === 0) return [];
      const key = after ? { k: after.timestamp, kid: after.id } : FIRST_PAGE;
      return (await request<{ Swap: SwapRec[] }>(SWAPS_FOR, { pools: poolIds, since, limit, ...key })).Swap;
    },
    async candlesFor(poolIds, since, openIds, after, limit) {
      if (poolIds.length === 0) return { recent: [], open: [] };
      if (after === null) {
        const d = await request<{ recent: CandleRec[]; open: CandleRec[] }>(CANDLES_FIRST, { pools: poolIds, since, limit, openIds, ...FIRST_PAGE });
        return { recent: d.recent, open: d.open };
      }
      const d = await request<{ recent: CandleRec[] }>(CANDLES_NEXT, { pools: poolIds, since, limit, k: after.t, kid: after.id });
      return { recent: d.recent, open: [] };
    },
    async tokensById(ids) {
      if (ids.length === 0) return [];
      return (await request<{ Token: TokenRec[] }>(TOKENS_BY_ID, { ids })).Token;
    },
    async topHolders(tokenId, limit) {
      return (await request<{ TokenBalance: BalanceRec[] }>(TOP_HOLDERS, { token: tokenId, limit })).TokenBalance;
    },
    async topHoldersBatch(tokenIds, limit) {
      if (tokenIds.length === 0) return [];
      const variables: Record<string, unknown> = { limit };
      tokenIds.forEach((id, i) => {
        variables[`t${i}`] = id;
      });
      const data = await request<Record<string, BalanceRec[]>>(topHoldersBatchDoc(tokenIds.length), variables);
      return tokenIds.flatMap((_, i) => data[`t${i}`]);
    },
    async chainMeta() {
      const d = await request<{ chain_metadata: ChainRow[] }>(CHAIN_META, {});
      const row = d.chain_metadata.find((c) => c.chain_id === CHAIN_ID);
      if (!row) throw new EnvioUnavailableError(`indexer has no chain_metadata row for chain ${CHAIN_ID}`);
      return { latestProcessedBlock: row.latest_processed_block, blockHeight: row.block_height };
    },
    tokensPage: (afterId, limit) => page<"Token", TokenRec>("Token", afterId, null, limit),
    poolsPage: (afterId, limit) => page<"Pool", PoolRec>("Pool", afterId, null, limit),
    swapsPage: (afterId, beforeId, limit) => page<"Swap", SwapRec>("Swap", afterId, beforeId, limit),
    candlesPage: (afterId, beforeId, limit) => page<"Candle", CandleRec>("Candle", afterId, beforeId, limit),
  };
}
