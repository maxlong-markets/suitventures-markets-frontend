import type {
  Address,
  Candle,
  Denom,
  Holder,
  Interval,
  MarketsDataSource,
  Quote,
  QuoteAsset,
  Side,
  TokenPair,
  Trade,
  VoteDir,
} from "@/lib/types";

/**
 * Live data layer — Envio HyperIndex behind Next.js route handlers, quotes
 * from the Uniswap v4 Quoter via Alchemy. Every method is a TODO; the mock
 * source is used until this lands (M1/M2 in the project README).
 *
 * Planned mapping:
 * - pairs()      → Envio `Token` + `Pool` entities (LONG launches, Pons
 *                  `PoolRegistered`, SV factory launches, the curated SUIT
 *                  pool), joined with 1h/24h candles for change and volume.
 * - quotes()     → allowlisted numeraires with USD prices (USDG pools first,
 *                  external API fallback — README §4).
 * - candles()    → Envio candle entities per poolId and interval.
 * - trades()     → PoolManager `Swap` events for the poolId.
 * - holders()    → balances from the token's `Transfer` events.
 * - quoteSwap()  → V4 Quoter `quoteExactInputSingle` through the SVRouter
 *                  path, plus the router and hook fees.
 * - watchlist(), setWatch(), vote(), votes() → route handlers keyed by
 *                  address, authorised by the session signature.
 */
export class EnvioDataSource implements MarketsDataSource {
  readonly kind = "envio" as const;

  private todo(method: string): never {
    throw new Error(`EnvioDataSource.${method} is not implemented yet.`);
  }

  quotes(): Promise<QuoteAsset[]> {
    return this.todo("quotes");
  }
  pairs(): Promise<TokenPair[]> {
    return this.todo("pairs");
  }
  candles(_id: string, _interval: Interval): Promise<Candle[]> {
    return this.todo("candles");
  }
  trades(_id: string): Promise<Trade[]> {
    return this.todo("trades");
  }
  holders(_id: string): Promise<Holder[]> {
    return this.todo("holders");
  }
  quoteSwap(
    _id: string,
    _side: Side,
    _amount: number,
    _denom: Denom,
    _isSuitHolder: boolean,
    _slippagePct: number,
  ): Promise<Quote> {
    return this.todo("quoteSwap");
  }
  watchlist(_address: Address): Promise<string[]> {
    return this.todo("watchlist");
  }
  setWatch(
    _address: Address,
    _id: string,
    _on: boolean,
    _signature: string,
  ): Promise<void> {
    return this.todo("setWatch");
  }
  vote(
    _address: Address,
    _id: string,
    _dir: VoteDir,
    _signature: string,
  ): Promise<void> {
    return this.todo("vote");
  }
  votes(_address: Address): Promise<Record<string, VoteDir>> {
    return this.todo("votes");
  }
}
