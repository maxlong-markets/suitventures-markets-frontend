import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  IntegerOutOfRangeError,
  SizeExceedsPaddingSizeError,
  createPublicClient,
  hexToString,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import { robinhoodChain } from "@/lib/chain";

/**
 * Reads from the chain: ERC-20 token metadata and Chainlink quote prices
 * (docs/superpowers/plans/2026-09-21-chain-reader.md, Task 5).
 *
 * No Multicall3 deployment is assumed. The public RPC accepts JSON-RPC batches of 100 and
 * refuses rapid unbatched bursts with HTTP 429, so `createChainClient` uses viem's `http`
 * transport with `batch: { batchSize: 100, wait: 16 }`: every read below fires in parallel and
 * the transport itself coalesces concurrent calls into a handful of HTTP requests.
 *
 * One bad token or feed never fails the batch: every per-item (and, for tokens, per-field) read
 * is caught internally and resolves to a fallback rather than rejecting, and the batch-level
 * `Promise.allSettled` calls are a second line of defense should a read somehow reject anyway.
 */

/** A viem public client on Robinhood Chain. URL: `rpcUrl`, else `CHAIN_RPC_URL`, else the chain's own default RPC. */
export function createChainClient(rpcUrl?: string) {
  const url = rpcUrl ?? process.env.CHAIN_RPC_URL;
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(url, { batch: { batchSize: 100, wait: 16 }, retryCount: 3 }),
  });
}

// ---------------------------------------------------------------------------
// Token metadata
//
// Ported from the indexer's src/effects/tokenMetadata.ts: try the standard string ABI first; a
// shape mismatch (a bytes32-style symbol/name, e.g. MKR) retries with the bytes32 ABI; any other
// failure (a revert, no code at the address, a transport error) resolves to the synthetic
// fallback (`symbol` the first 6 characters of the address, `name` the address, `decimals` 18).
// Bytes32 values and stray NULs are cleaned, and symbol/name are capped by Unicode code point,
// never by UTF-16 unit, so a multi-unit character (an emoji) is kept or dropped whole rather than
// split into a lone surrogate.
//
// `totalSupply` is new here: the indexer never called it directly (it summed ERC-20 Transfer
// events instead, and this reader does not index Transfer at all — see the plan's Global
// Constraints). It is read as a fourth, independent call whose own failure never affects `ok`.
// ---------------------------------------------------------------------------

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const ERC20_BYTES32_ABI = parseAbi([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
  "function decimals() view returns (uint8)",
]);

const MAX_SYMBOL_LENGTH = 32;
const MAX_NAME_LENGTH = 128;

export type TokenMetadataReading = {
  ok: boolean;
  symbol: string;
  name: string;
  decimals: number;
  /** null when the totalSupply read failed; a raw on-chain integer, so it never passes through `number`. */
  totalSupply: bigint | null;
};

function fallbackMetadata(address: string): Omit<TokenMetadataReading, "ok" | "totalSupply"> {
  return { symbol: address.slice(0, 6), name: address, decimals: 18 };
}

// bytes32 names are padded with NUL bytes, and some string returns carry stray NULs too; strip
// both, then trim, before capping length or validating. Applies to both decode paths.
function clean(s: string): string {
  return s.replace(/\x00/g, "").trim();
}

// Caps `s` at `max` Unicode code points, not UTF-16 code units: `.slice`/`.substring` count code
// units and can cut a surrogate pair (an emoji) in half. Iterating via Array.from walks whole
// code points, so a multi-unit character is always kept or dropped whole.
function capCodePoints(s: string, max: number): string {
  return Array.from(s.slice(0, max * 2))
    .slice(0, max)
    .join("");
}

/**
 * True when the string-ABI read failed with a shape mismatch a bytes32 retry could fix (ported
 * verbatim from the indexer, confirmed against viem@2.56.3: a bytes32 symbol/name read with the
 * string ABI throws IntegerOutOfRangeError, not one of the AbiDecoding*Error classes). False for
 * a zero-data or revert error (no valid return under any ABI, so a retry would just repeat the
 * failure) and for transport/RPC errors (so a transient failure is never misread as "bytes32").
 */
function shouldRetryAsBytes32(err: unknown): boolean {
  const isUnrecoverable =
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof AbiDecodingZeroDataError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof ContractFunctionRevertedError,
    ) !== null;
  if (isUnrecoverable) return false;

  return (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof AbiDecodingDataSizeTooSmallError ||
        e instanceof IntegerOutOfRangeError ||
        e instanceof SizeExceedsPaddingSizeError,
    ) !== null
  );
}

// Cleans and bounds-checks a decoded triple. undefined (a failed read) for a blank symbol/name
// after cleaning, or a decimals value outside uint8's real range — viem decodes whatever 32-byte
// word is there with no 8-bit check of its own, so a hostile decimals() has to be rejected here.
function validateMetadata(
  rawSymbol: string,
  rawName: string,
  rawDecimals: number,
): { symbol: string; name: string; decimals: number } | undefined {
  const symbol = capCodePoints(clean(rawSymbol), MAX_SYMBOL_LENGTH);
  const name = capCodePoints(clean(rawName), MAX_NAME_LENGTH);
  if (!symbol || !name) return undefined;
  if (!Number.isInteger(rawDecimals) || rawDecimals < 0 || rawDecimals > 255) return undefined;
  return { symbol, name, decimals: rawDecimals };
}

/** `address` must already be lowercase. Never throws: every failure path resolves to the fallback shape. */
async function readErc20Metadata(
  client: Pick<PublicClient, "readContract">,
  address: string,
): Promise<{ ok: boolean; symbol: string; name: string; decimals: number }> {
  const addr = address as `0x${string}`;
  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    const validated = validateMetadata(symbol, name, decimals);
    return validated ? { ...validated, ok: true } : { ...fallbackMetadata(address), ok: false };
  } catch (err) {
    if (!shouldRetryAsBytes32(err)) {
      return { ...fallbackMetadata(address), ok: false };
    }
  }
  try {
    const [symbolBytes, nameBytes, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20_BYTES32_ABI, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ERC20_BYTES32_ABI, functionName: "name" }),
      client.readContract({ address: addr, abi: ERC20_BYTES32_ABI, functionName: "decimals" }),
    ]);
    const validated = validateMetadata(hexToString(symbolBytes), hexToString(nameBytes), decimals);
    return validated ? { ...validated, ok: true } : { ...fallbackMetadata(address), ok: false };
  } catch {
    return { ...fallbackMetadata(address), ok: false };
  }
}

/** `address` must already be lowercase. Never throws: a failed read (revert, no code, transport error) is null. */
async function readTotalSupply(
  client: Pick<PublicClient, "readContract">,
  address: string,
): Promise<bigint | null> {
  try {
    return await client.readContract({
      address: address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "totalSupply",
    });
  } catch {
    return null;
  }
}

/**
 * Symbol, name, decimals and totalSupply for each ERC-20 in `addresses`, keyed by lowercase
 * address. Every read fires in parallel — per token and per field — and one token's failure never
 * fails the batch or any other token's entry: a token whose metadata read fails gets the
 * indexer's fallback shape (`ok: false`); totalSupply fails independently to `null` regardless of
 * `ok`. The caller retries a failed token later.
 */
export async function readTokenMetadata(
  client: Pick<PublicClient, "readContract">,
  addresses: readonly string[],
): Promise<Map<string, TokenMetadataReading>> {
  const settled = await Promise.allSettled(
    addresses.map(async (raw) => {
      const address = raw.toLowerCase();
      const [metadata, totalSupply] = await Promise.all([
        readErc20Metadata(client, address),
        readTotalSupply(client, address),
      ]);
      return [address, { ...metadata, totalSupply }] as const;
    }),
  );

  const result = new Map<string, TokenMetadataReading>();
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      const [address, reading] = outcome.value;
      result.set(address, reading);
      return;
    }
    const address = addresses[i]!.toLowerCase();
    result.set(address, { ...fallbackMetadata(address), ok: false, totalSupply: null });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Chainlink quote prices
//
// Ported from the indexer's src/handlers/chainlink.ts and src/lib/quotes.ts: the answer is an
// int256 scaled by the feed's configured decimals. The indexer instead subscribed to the
// underlying aggregator's own AnswerUpdated event and tracked its rotations via
// AggregatorConfirmed; this is a plain on-demand read with no event history to follow, so
// latestRoundData() is called on the PROXY directly (the plan's instruction), and the proxy
// address itself stands in for "aggregator" in the result. USDG has no Chainlink feed and is
// pinned at 1, aggregator "pinned", exactly as the indexer's shared.ts#ensureQuote seeded it.
// ---------------------------------------------------------------------------

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Global Dollar, address lowercase (indexer src/lib/constants.ts USDG). Pinned at 1: it has no Chainlink feed. */
const USDG_ADDRESS = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const MAX_SANE_TIMESTAMP = BigInt(Number.MAX_SAFE_INTEGER);

export type QuoteFeedConfig = {
  /** The quote asset's own address — the `id` of the resulting price reading, not the feed's. */
  address: string;
  chainlinkProxy: string | null;
  chainlinkDecimals: number | null;
};

export type QuotePriceReading = {
  id: string;
  usdPrice: number;
  updatedAt: number;
  aggregator: string;
};

/** Never throws: a skip (no feed configured, a non-positive answer, or a reverting read) resolves to null. */
async function readOneQuotePrice(
  client: Pick<PublicClient, "readContract">,
  quote: QuoteFeedConfig,
  now: number,
): Promise<QuotePriceReading | null> {
  const id = quote.address.toLowerCase();
  if (id === USDG_ADDRESS) {
    return { id, usdPrice: 1, updatedAt: now, aggregator: "pinned" };
  }
  const { chainlinkProxy, chainlinkDecimals } = quote;
  if (!chainlinkProxy || chainlinkDecimals === null) return null;
  const proxy = chainlinkProxy.toLowerCase();
  try {
    const [, answer, , updatedAt] = await client.readContract({
      address: proxy as `0x${string}`,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    });
    if (answer <= 0n) return null;
    const usdPrice = Number(answer) / 10 ** chainlinkDecimals;
    const updatedAtIsSane = updatedAt > 0n && updatedAt <= MAX_SANE_TIMESTAMP;
    return { id, usdPrice, updatedAt: updatedAtIsSane ? Number(updatedAt) : now, aggregator: proxy };
  } catch {
    return null;
  }
}

/**
 * USD prices for `quotes`, one entry per quote with a usable price right now: a quote with no
 * Chainlink feed configured is silently absent (not an error), and so is one whose feed reverted
 * or answered zero/negative — the caller keeps the quote's last known price and retries next
 * cycle. USDG is always present, pinned at 1.
 */
export async function readQuotePrices(
  client: Pick<PublicClient, "readContract">,
  quotes: readonly QuoteFeedConfig[],
  now: number,
): Promise<QuotePriceReading[]> {
  const settled = await Promise.allSettled(quotes.map((quote) => readOneQuotePrice(client, quote, now)));
  const results: QuotePriceReading[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value) results.push(outcome.value);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Wallet balances (holder-count upkeep, 2026-09-22; see holder-count-report.md's "Fix round 1" for
// the review at .superpowers/sdd/2026-09-21-chain-reader/holder-count-review.md that reshaped this)
//
// The chain reader deliberately does not index ERC-20 Transfer (see the design doc's "What is
// deliberately not indexed"), so holders_count can no longer be derived by summing transfers. It
// instead drifts forward from its 17 Sep baseline, moved by the wallets that trade: a wallet's
// balanceOf, read TWICE per (token, wallet) pair a batch's trades touch — once before the batch, once
// after — tells run.ts's computeHolderDeltas whether that wallet crossed the zero line. See run.ts for
// the delta rule itself and why both sides are observed rather than one derived from the other.
// ---------------------------------------------------------------------------

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export type BalancePair = { token: string; wallet: string };

/**
 * The map key readBalances uses for one pair, and the ONLY place that builds it — exported so a
 * caller building a lookup against readBalances' own result (run.ts's computeHolderDeltas) uses this
 * instead of its own copy of the format string. Fix round 1, MINOR-6
 * (.superpowers/sdd/2026-09-21-chain-reader/holder-count-review.md): before this, run.ts had its own
 * `holderPairKey` that agreed with this file's inline key only because every caller already happened
 * to pass lowercase input — a real but silent drift risk (a mismatched key means every lookup misses,
 * every pair falls into "unknown", and holders_count silently stops moving, with nothing to say why).
 * Lowercases both sides itself, so neither side of a comparison has to remember to.
 */
export function balancePairKey(pair: BalancePair): string {
  return `${pair.token.toLowerCase()}-${pair.wallet.toLowerCase()}`;
}

/**
 * Races `promise` against a `timeoutMs` timer; on timeout, rejects (never resolves to a guessed
 * value), so `readBalances`' own `Promise.allSettled` treats a timeout exactly like any other per-pair
 * failure — absent from the map, never `0n`. Does not cancel the underlying `readContract` call (viem
 * exposes no per-call abort on this path): a slow response keeps running in the background and its
 * result is simply discarded, so this bounds how long the CALLER waits, not the node's own work.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * ERC-20 `balanceOf` for each (token, wallet) pair in `pairs`, keyed by balancePairKey (both sides
 * lowercased). `blockNumber` reads a historical balance; omitted, it reads the current balance.
 * `timeoutMs`, when given, bounds each individual read (fix round 1, MAJOR-2 — see run.ts's
 * HOLDER_READ_TIMEOUT_MS for why 5s and why per-pair, not per-batch: viem's client batches up to 100
 * calls into one HTTP request, so a per-pair race still lets every OTHER in-flight HTTP batch resolve
 * on its own schedule instead of the slowest one holding up the whole call).
 *
 * Same failure discipline as readTokenMetadata: one pair's read failing — a revert, no code at the
 * address, a transport error, a timeout, or (a historical block whose state has been pruned) — never
 * fails the batch. UNLIKE readTokenMetadata, though, there is no safe fallback VALUE for a balance: 0
 * is a real, meaningful answer here (it is exactly what turns a holder into a non-holder), so a failed
 * read is ABSENT from the returned map rather than defaulted to 0n — guessing it would corrupt the
 * count. The caller must treat a missing key as "unknown," never as "zero."
 *
 * The viem client already batches up to 100 calls into one HTTP request (createChainClient's
 * `batch.batchSize`); every read here fires in parallel and relies entirely on that transport-level
 * batching — this function never chunks or throttles the list itself.
 */
export async function readBalances(
  client: Pick<PublicClient, "readContract">,
  pairs: readonly BalancePair[],
  blockNumber?: bigint,
  timeoutMs?: number,
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  // Sequential chunks of BALANCE_READ_CHUNK, never everything at once. The transport batches every read
  // issued within its 16 ms window into ONE JSON-RPC batch, and the public node counts each call in a
  // batch toward its rate limit: measured 22 Sep 2026, a batch of 50 balanceOf calls resolves in ~400 ms
  // while 60 or more answers HTTP 429 "Too Many Requests" for the WHOLE batch, so a busy cycle's pairs
  // issued together resolved zero of them and every holder count stayed frozen. Awaiting each chunk
  // keeps at most BALANCE_READ_CHUNK calls in one batch and spaces the batches out.
  for (let i = 0; i < pairs.length; i += BALANCE_READ_CHUNK) {
    const chunk = pairs.slice(i, i + BALANCE_READ_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map(async (pair) => {
        const token = pair.token.toLowerCase();
        const wallet = pair.wallet.toLowerCase();
        const read = client.readContract({
          address: token as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [wallet as `0x${string}`],
          blockNumber,
        });
        const balance = await (timeoutMs === undefined ? read : withDeadline(read, timeoutMs));
        return { key: balancePairKey(pair), balance };
      }),
    );
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") result.set(outcome.value.key, outcome.value.balance);
      // A rejected read (including a timeout) is left absent — see the doc comment above.
    }
  }
  return result;
}

/** Reads per JSON-RPC batch for balanceOf: the measured ceiling on the public node is 50 before it answers 429 for the whole batch. */
export const BALANCE_READ_CHUNK = 40;
