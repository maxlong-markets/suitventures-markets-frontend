import { POOL_MANAGER, TOPIC0 } from "./abi";
import { decodeLog, type RawLog } from "./decode";
import type { ChainEvent, LogSource, TransferEvent } from "./types";

export type HyperSyncSourceOptions = {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

const DEFAULT_URL = "https://4663.hypersync.xyz";
// Total HTTP attempts (the first try plus retries) a 429, 5xx or network error gets before this
// gives up and throws the last error. 401/403 never retry at all, whatever this is set to.
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Capped exponential backoff. attemptIndex 0 is the wait after the first failed attempt. */
function backoffMs(attemptIndex: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attemptIndex, MAX_DELAY_MS);
}

/** HyperSync's `Retry-After`, in ms; undefined when absent or not a finite non-negative number. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

// A block's `timestamp` is a hex string in production ("0x6ab0f871"). BigInt("") is 0n, so an
// empty (or otherwise non-hex) string must be rejected explicitly before reaching BigInt — it
// must never silently become timestamp 0, the same "no silent fallback" rule that already applies
// to a log whose block row is absent entirely.
const HEX_TIMESTAMP_RE = /^0x[0-9a-fA-F]+$/;

/** A plain number is accepted too, defensively. Throws, naming `blockNumber`, for anything that isn't a number or a non-empty hex string. */
function parseBlockTimestamp(value: string | number, blockNumber: number): number {
  if (typeof value === "number") return value;
  if (!HEX_TIMESTAMP_RE.test(value)) {
    throw new Error(`HyperSync block ${blockNumber} has a malformed timestamp: ${JSON.stringify(value)}`);
  }
  return Number(BigInt(value));
}

type HyperSyncBlock = { number: number; timestamp: string | number };
type HyperSyncTransaction = { hash: string; from: string | null };
type HyperSyncLog = {
  block_number: number;
  log_index: number;
  transaction_hash: string;
  data: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
};
type HyperSyncChunk = { logs?: HyperSyncLog[]; blocks?: HyperSyncBlock[]; transactions?: HyperSyncTransaction[] };
type HyperSyncQueryResponse = { data: HyperSyncChunk[]; next_block: number; archive_height?: number };
type HyperSyncHeightResponse = { height: number };

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (topic: unknown): string | null =>
  typeof topic === "string" && topic.length === 66 ? `0x${topic.slice(26).toLowerCase()}` : null;

/**
 * Topics in the order HyperSync sent them, from whichever of topic0..topic3 are present, stopping
 * at the first missing one: a log's absent topics are simply missing keys (verified against the
 * live service 21 Sep 2026), so topic3 is routinely absent and must not become a "0x0..0" topic.
 */
function buildTopics(log: HyperSyncLog): string[] {
  const candidates = [log.topic0, log.topic1, log.topic2, log.topic3];
  const topics: string[] = [];
  for (const t of candidates) {
    if (t === undefined || t === null) break;
    topics.push(t);
  }
  return topics;
}

/**
 * `LogSource` over HyperSync (`https://4663.hypersync.xyz` by default). Every request retries
 * 429s, 5xx and network errors with a capped exponential backoff — `Retry-After` is honoured as a
 * floor under that backoff, never a replacement for it, so a short or zero header can never pin
 * the wait below the escalating curve. 401/403 fail on the first attempt, with a message that
 * never echoes the token. `fetchImpl` and `sleep` are injected so tests never touch the network
 * or a real timer; the token is read lazily (first call, not construction) so a source can be
 * built before the environment carries one.
 */
export function createHyperSyncSource(opts: HyperSyncSourceOptions = {}): LogSource {
  // `||`, not `??`: an empty NEXT_PUBLIC_RPC_URL already means "use the default" elsewhere in this
  // repo (src/lib/chain.ts) because an unset env var can still reach here as "" rather than
  // undefined; the same treatment applies to every fallback below.
  const url = opts.url || process.env.HYPERSYNC_URL || DEFAULT_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let requests = 0;

  function getToken(): string {
    const token = opts.token || process.env.HYPERSYNC_API_TOKEN || process.env.ENVIO_API_TOKEN;
    if (!token) throw new Error("HYPERSYNC_API_TOKEN (or ENVIO_API_TOKEN) is not set");
    return token;
  }

  /** POSTs/GETs one HyperSync request, retrying per this function's own doc above. `requests` counts every attempt. */
  async function request(path: string, method: "GET" | "POST", extraHeaders: Record<string, string>, body?: string): Promise<unknown> {
    const token = getToken();
    const headers: Record<string, string> = { ...extraHeaders, Authorization: `Bearer ${token}` };
    let attemptsMade = 0;

    // Shared by every retryable failure below (network error, malformed JSON body, 429, 5xx):
    // sleeps `waitMs` and returns, or throws `err` once `maxAttempts` is exhausted.
    async function retryOrThrow(err: unknown, waitMs: number): Promise<void> {
      if (attemptsMade >= maxAttempts) throw err;
      await sleep(waitMs);
    }

    for (;;) {
      attemptsMade += 1;
      requests += 1;
      let res: Response;
      try {
        res = await fetchImpl(`${url}${path}`, { method, headers, body });
      } catch (err) {
        await retryOrThrow(err, backoffMs(attemptsMade - 1));
        continue;
      }
      if (res.ok) {
        // A truncated or otherwise malformed body on an ok response is just as transient-shaped
        // as a network error or a 5xx (responses run to several MB and a catch-up makes
        // thousands of sequential calls), so it gets the same retry treatment rather than
        // failing the whole call on one mid-stream hiccup.
        try {
          return (await res.json()) as unknown;
        } catch (err) {
          await retryOrThrow(err, backoffMs(attemptsMade - 1));
          continue;
        }
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("HyperSync rejected the API token");
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.max(retryAfterMs(res) ?? 0, backoffMs(attemptsMade - 1));
        await retryOrThrow(new Error(`HyperSync request failed with status ${res.status}`), wait);
        continue;
      }
      // Any other 4xx is not retryable.
      throw new Error(`HyperSync request failed with status ${res.status}`);
    }
  }

  return {
    async head() {
      const body = (await request("/height", "GET", {})) as HyperSyncHeightResponse;
      return body.height;
    },

    async fetch(fromBlock: number, toBlock: number) {
      const queryBody = {
        from_block: fromBlock,
        to_block: toBlock + 1, // HyperSync's to_block is exclusive
        logs: [{ address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] }],
        field_selection: {
          block: ["number", "timestamp"],
          log: ["block_number", "log_index", "transaction_hash", "topic0", "topic1", "topic2", "topic3", "data"],
          transaction: ["hash", "from"],
        },
      };
      const response = (await request(
        "/query",
        "POST",
        { "Content-Type": "application/json" },
        JSON.stringify(queryBody),
      )) as HyperSyncQueryResponse;

      // `Math.min` coerces with ToNumber: a missing or non-numeric next_block would silently
      // become NaN, and `NaN <= fromBlock` is false, so the no-progress guard below would never
      // fire for it — this must throw here instead, before nextBlock is ever computed. Mirrors
      // the reference client's fetchPage check (SuitVenturesMarket-indexer/src/lib/hypersync.ts).
      if (!Array.isArray(response.data) || !Number.isInteger(response.next_block)) {
        throw new Error(`HyperSync response malformed for block ${fromBlock}: missing data array or next_block`);
      }

      // A log's block or transaction can sit in a different chunk of the response than the log
      // itself, so every chunk's blocks and transactions are joined before any log is decoded.
      const timestamps = new Map<number, number>();
      const senders = new Map<string, string | null>();
      for (const chunk of response.data) {
        for (const b of chunk.blocks ?? []) {
          const blockNumber = Number(b.number);
          timestamps.set(blockNumber, parseBlockTimestamp(b.timestamp, blockNumber));
        }
        for (const t of chunk.transactions ?? []) {
          senders.set(t.hash.toLowerCase(), t.from ? t.from.toLowerCase() : null);
        }
      }

      const events: ChainEvent[] = [];
      for (const chunk of response.data) {
        for (const log of chunk.logs ?? []) {
          const blockNumber = Number(log.block_number);
          const timestamp = timestamps.get(blockNumber);
          if (timestamp === undefined) {
            throw new Error(`HyperSync log at block ${blockNumber} has no matching block timestamp`);
          }
          const rawLog: RawLog = {
            blockNumber,
            logIndex: Number(log.log_index),
            txHash: log.transaction_hash,
            topics: buildTopics(log),
            data: log.data,
            timestamp,
            txFrom: senders.get(log.transaction_hash.toLowerCase()) ?? null,
          };
          const decoded = decodeLog(rawLog);
          if (decoded) events.push(decoded);
        }
      }

      events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

      const nextBlock = Math.min(response.next_block, toBlock + 1);
      if (nextBlock <= fromBlock) {
        throw new Error(`HyperSync made no progress past block ${fromBlock} (next_block=${String(response.next_block)})`);
      }
      return { events, nextBlock };
    },

    async transfers(token: string, fromBlock: number) {
      const queryBody = {
        from_block: fromBlock,
        logs: [{ address: [token.toLowerCase()], topics: [[TRANSFER_TOPIC0]] }],
        field_selection: { log: ["block_number", "log_index", "topic1", "topic2", "data"] },
      };
      const response = (await request(
        "/query",
        "POST",
        { "Content-Type": "application/json" },
        JSON.stringify(queryBody),
      )) as HyperSyncQueryResponse;
      if (!Array.isArray(response.data) || !Number.isInteger(response.next_block)) {
        throw new Error(`HyperSync transfers response malformed for block ${fromBlock}: missing data array or next_block`);
      }
      if (response.next_block <= fromBlock) throw new Error(`HyperSync transfers made no progress from block ${fromBlock}`);
      const transfers: TransferEvent[] = [];
      for (const chunk of response.data) {
        for (const log of chunk.logs ?? []) {
          // An ERC-721 Transfer carries the token id as a fourth topic; it is not a balance movement.
          if (log.topic3 != null) continue;
          const from = topicAddress(log.topic1);
          const to = topicAddress(log.topic2);
          if (!from || !to) continue;
          const data = typeof log.data === "string" && log.data.length > 2 ? log.data : "0x0";
          transfers.push({ block: Number(log.block_number), logIndex: Number(log.log_index), from, to, value: BigInt(data) });
        }
      }
      transfers.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      return { transfers, nextBlock: response.next_block };
    },

    get requests() {
      return requests;
    },
  };
}
