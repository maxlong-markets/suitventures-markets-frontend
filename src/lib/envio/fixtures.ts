import type { TokenRow, QuotePriceRow, WindowRow, CandleRow, SwapRow, BalanceRow, QuoteRow } from "./queries";

export const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
export const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
export const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
export const NOW = 1_757_700_000;

export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const prices: QuotePriceRow[] = [
  { id: NVDA, usdPrice: 224.4, updatedAt: NOW - 600, aggregator: "0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2" },
  // USDG is pinned at 1 and its updatedAt never moves: 99 days old on the deployed indexer.
  { id: USDG, usdPrice: 1, updatedAt: NOW - 8_500_000, aggregator: "pinned" },
  { id: "0xstale", usdPrice: 50, updatedAt: NOW - 400_000, aggregator: "0xdeadfeed" },
];

export const aiToken: TokenRow = {
  id: AI, address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", symbol: "AI", name: "Artificial Inu", decimals: 18,
  totalSupply: "1000000000000000000000000000", holdersCount: 18423, origin: "LONG", createdAt: NOW - 5_000_000,
  primaryPool: {
    id: POOL, quote_id: NVDA, tokenIsCurrency0: true, hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544", fee: 8388608, tickSpacing: 8,
    origin: "LONG", createdAt: NOW - 5_000_000, priceQuote: 0.000866, tvlToken: "1000000000000000000000000", tvlQuote: "10000000000000000000000",
    swapCount: 5000, lastSwapAt: NOW - 30, quote: { symbol: "NVDA", decimals: 18 },
  },
};

// h1 candles for POOL. NOW sits on an hour boundary, so the 1h bucket is NOW - 3600 and the 24h bucket is NOW - 86400.
export const windowRows: WindowRow[] = [
  { pool_id: POOL, t: NOW - 86400, open: 0.001, close: 0.00095, volumeQuote: 0 },
  { pool_id: POOL, t: NOW - 7200, open: 0.0009, close: 0.00089, volumeQuote: 8.6 },
  { pool_id: POOL, t: NOW - 3600, open: 0.00088, close: 0.00087, volumeQuote: 10 },
];
export const quotes: QuoteRow[] = [{ id: NVDA, symbol: "NVDA", name: "NVIDIA Robinhood Token", decimals: 18, address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" }];
export const candles: CandleRow[] = [
  { t: NOW - 900, open: 0.0009, high: 0.00092, low: 0.00088, close: 0.0009, volumeQuote: 3 },
  { t: NOW - 1800, open: 0.00095, high: 0.00096, low: 0.0009, close: 0.0009, volumeQuote: 4 },
];
export const swaps: SwapRow[] = [{ timestamp: NOW - 30, side: "buy", amountToken: 15749, priceQuote: 0.000865, wallet: "0xce73000000000000000000000000000000006329", txHash: "0x" + "ab".repeat(32) }];
export const balances: BalanceRow[] = [
  { holder: "0x8366a39cc670b4001a1121b8f6a443a643e40951", balance: "84684155000000000000000000" },
  { holder: "0xb12e000000000000000000000000000000005020", balance: "84242846000000000000000000" },
];
