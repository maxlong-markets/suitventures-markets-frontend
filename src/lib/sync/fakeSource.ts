import type { BalanceRec, CandleCursor, CandleRec, CreatedCursor, EnvioSource, PoolCursor, PoolRec, QuotePriceRec, QuoteRec, SwapCursor, SwapRec, TokenRec } from "./source";

export type FakeData = {
  quotes?: QuoteRec[]; prices?: QuotePriceRec[]; pools?: PoolRec[]; tokens?: TokenRec[]; swaps?: SwapRec[];
  candles?: CandleRec[]; balances?: BalanceRec[]; chain?: { latestProcessedBlock: number; blockHeight: number };
};

type Keyed = { key: number; id: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Rows strictly after (key, id), ordered (key asc, id asc), at most limit. */
function keyset<T>(rows: readonly T[], key: (r: T) => number, id: (r: T) => string, after: Keyed | null, limit: number): T[] {
  return rows
    .filter((r) => after === null || key(r) > after.key || (key(r) === after.key && id(r) > after.id))
    .sort((a, b) => key(a) - key(b) || cmp(id(a), id(b)))
    .slice(0, limit);
}

/** Rows with afterId < id (< beforeId when given), ascending by id, at most limit. */
function idRange<T extends { id: string }>(rows: readonly T[], afterId: string, beforeId: string | null, limit: number): T[] {
  return rows
    .filter((r) => r.id > afterId && (beforeId === null || r.id < beforeId))
    .sort((a, b) => cmp(a.id, b.id))
    .slice(0, limit);
}

const nonZero = (b: BalanceRec) => BigInt(b.balance) > 0n;

/** Non-zero balances of one token, largest first (ties by holder ascending) — same ranking real Envio applies. */
function holdersOf(balances: readonly BalanceRec[], tokenId: string, limit: number): BalanceRec[] {
  return balances
    .filter((b) => b.token_id === tokenId && nonZero(b))
    .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : cmp(a.holder, b.holder)))
    .slice(0, limit);
}

/** In-memory EnvioSource applying exactly the filters, orderings and keysets documented on the interface. `calls` records method names in order; `failOn` makes the named method throw the given error on its next call. */
export class FakeSource implements EnvioSource {
  readonly data: Required<FakeData>;
  readonly calls: string[] = [];
  queries = 0;
  failOn: { method: keyof EnvioSource; error: Error } | null = null;

  constructor(data: FakeData) {
    this.data = {
      quotes: data.quotes ?? [], prices: data.prices ?? [], pools: data.pools ?? [], tokens: data.tokens ?? [], swaps: data.swaps ?? [],
      candles: data.candles ?? [], balances: data.balances ?? [], chain: data.chain ?? { latestProcessedBlock: 0, blockHeight: 0 },
    };
  }

  /** Records the call and counts the request before an armed failure fires, as a real request would. */
  private hit(method: keyof EnvioSource): void {
    this.calls.push(method);
    this.queries += 1;
    if (this.failOn?.method === method) {
      const { error } = this.failOn;
      this.failOn = null;
      throw error;
    }
  }

  async quotes() {
    this.hit("quotes");
    return { quotes: [...this.data.quotes], prices: [...this.data.prices] };
  }
  async poolsSince(since: number, after: PoolCursor | null, limit: number) {
    this.hit("poolsSince");
    const rows = this.data.pools.filter((p) => p.lastSwapAt !== null && p.lastSwapAt >= since);
    return keyset(rows, (p) => p.lastSwapAt ?? 0, (p) => p.id, after && { key: after.lastSwapAt, id: after.id }, limit);
  }
  async poolsCreatedSince(since: number, after: CreatedCursor | null, limit: number) {
    this.hit("poolsCreatedSince");
    const rows = this.data.pools.filter((p) => p.lastSwapAt === null && p.createdAt >= since);
    return keyset(rows, (p) => p.createdAt, (p) => p.id, after && { key: after.createdAt, id: after.id }, limit);
  }
  async swapsFor(poolIds: readonly string[], since: number, after: SwapCursor | null, limit: number) {
    this.hit("swapsFor");
    const pools = new Set(poolIds);
    const rows = this.data.swaps.filter((s) => pools.has(s.pool_id) && s.timestamp >= since);
    return keyset(rows, (s) => s.timestamp, (s) => s.id, after && { key: after.timestamp, id: after.id }, limit);
  }
  async candlesFor(poolIds: readonly string[], since: number, openIds: readonly string[], after: CandleCursor | null, limit: number) {
    this.hit("candlesFor");
    const pools = new Set(poolIds);
    const open = new Set(openIds);
    const rows = this.data.candles.filter((c) => pools.has(c.pool_id) && c.t >= since);
    return {
      recent: keyset(rows, (c) => c.t, (c) => c.id, after && { key: after.t, id: after.id }, limit),
      open: after === null ? this.data.candles.filter((c) => open.has(c.id)) : [],
    };
  }
  async tokensById(ids: readonly string[]) {
    this.hit("tokensById");
    const wanted = new Set(ids);
    return this.data.tokens.filter((t) => wanted.has(t.id));
  }
  async topHolders(tokenId: string, limit: number) {
    this.hit("topHolders");
    return holdersOf(this.data.balances, tokenId, limit);
  }
  async topHoldersBatch(tokenIds: readonly string[], limit: number) {
    this.hit("topHoldersBatch");
    return tokenIds.flatMap((id) => holdersOf(this.data.balances, id, limit));
  }
  async chainMeta() {
    this.hit("chainMeta");
    return { ...this.data.chain };
  }
  async tokensPage(afterId: string, limit: number) {
    this.hit("tokensPage");
    return idRange(this.data.tokens, afterId, null, limit);
  }
  async poolsPage(afterId: string, limit: number) {
    this.hit("poolsPage");
    return idRange(this.data.pools, afterId, null, limit);
  }
  async swapsPage(afterId: string, beforeId: string | null, limit: number) {
    this.hit("swapsPage");
    return idRange(this.data.swaps, afterId, beforeId, limit);
  }
  async candlesPage(afterId: string, beforeId: string | null, limit: number) {
    this.hit("candlesPage");
    return idRange(this.data.candles, afterId, beforeId, limit);
  }
}
