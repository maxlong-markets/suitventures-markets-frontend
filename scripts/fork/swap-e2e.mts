/**
 * End-to-end proof on the anvil fork: a real buy and a real sell on AI/NVDA and MARIO/NVDA,
 * priced by the quote route's own brain (`priceSwap` over the V4 Quoter) and executed by the
 * browser's own `executeSwap` — the same modules, the same `call` block, the same Permit2
 * signature. Asserts every Trade event's amountOut is at least the amountOutMin the quote
 * signed for, that fee is exactly 0.5 % of the input floored (no SUITS_NFT on this deploy, so no
 * holder discount) and that holderRate is false, and exits non-zero on any failed assertion.
 * A SwapUnconfirmedError — sent, but the outcome could not be read — is reported as UNCONFIRMED,
 * not FAILED: src/lib/swap.ts's own contract is that this must never be reported as a failure.
 *
 * Run: npm run fork:e2e   (after npm run fork:anvil and npm run fork:deploy)
 *
 * It reads .env.local for DATABASE_URL (pool keys come from the market store) and .env.fork,
 * loaded second so its NEXT_PUBLIC_RPC_URL and NEXT_PUBLIC_SVROUTER_ADDRESS win.
 */
import assert from "node:assert/strict";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddressEqual,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain, SVROUTER_ADDRESS } from "@/lib/chain";
import { getBackend } from "@/lib/market/backend";
import type { PoolKeyRow } from "@/lib/market/poolKey";
import { toHuman } from "@/lib/quote/math";
import { priceSwap } from "@/lib/quote/price";
import { createQuoter } from "@/lib/quote/quoter";
import { executeSwap, SwapUnconfirmedError } from "@/lib/swap";
import type { Denom, Side } from "@/lib/types";

// No Foundry CLI runs from this script — it talks to the fork over JSON-RPC only — but every
// fork script sets this so a future subprocess call can never leak the nightly banner into
// captured output (verified 18 Sep 2026).
process.env.FOUNDRY_DISABLE_NIGHTLY_WARNING ??= "1";

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const SLIPPAGE_BPS = 100; // 1 %
/**
 * Pools to exercise (spec section 7), identified by the traded token's own contract address —
 * not by ticker, and resolved with `pair(id)` rather than a `pairs("all")` search.
 *
 * Brief-vs-reality, proven live on 18 Sep 2026, in two steps:
 * 1. Searching `pairs("all")` for `ticker === "AI" && quote === "NVDA"` — what an earlier version
 *    of this script did — matches TWO different on-chain tokens, and the market store's array
 *    order put the wrong one first: the unit-fixture AI (`0x2e8c3116…`, tickSpacing 8, no real
 *    liquidity), not the router-proven one (tickSpacing 200) the contracts repo's fork suite
 *    trades. `TokenPair.id`'s own doc comment says why this can happen at all: "thousands of
 *    memecoins share tickers." That pool's `swapExactIn` simulation reverted with no decodable
 *    reason.
 * 2. Matching on `poolId` instead (still through `pairs("all")`) fixed the collision but then
 *    found nothing: `pairs("all")` is the capped list the table renders (README: "one `TokenPair`
 *    … for a token outside the 500-row list, so deep links work" — the real AI/NVDA pair is
 *    outside it). `pair(id)`, keyed by the token's own lowercase address per `TokenPair.id`'s doc
 *    comment, is the method built for exactly this: "listed or not; null when the source does not
 *    know it."
 *
 * `roundTrip` below still asserts the resolved pool id against the one recorded here, so a wrong
 * address would fail loudly rather than quietly trade the wrong pool.
 */
const POOLS: ReadonlyArray<{ ticker: string; quote: string; tokenAddress: Address; poolId: Address }> = [
  {
    ticker: "AI",
    quote: "NVDA",
    tokenAddress: "0x68082B7EA5eE83cA3BD992f038ef02c0180b9Ba3",
    poolId: "0x8b7f6b0cc404947b4c5d32b02353b82d432c98d61497a07f2a42f4ed5a3c19ee",
  },
  {
    ticker: "MARIO",
    quote: "NVDA",
    tokenAddress: "0x7a492b0A2d630b94791Af846C1842Db9e623420c",
    poolId: "0xfad0b2c67dd7750f4f9392361ea1567db57b87ac015bfc519960089e73df2f15",
  },
];

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "";
const privateKey = process.env.FORK_PRIVATE_KEY ?? "";
if (!LOCAL_RPC.test(rpcUrl)) {
  die("NEXT_PUBLIC_RPC_URL must point at the local anvil fork (see .env.fork); refusing to trade anywhere else.");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  die("FORK_PRIVATE_KEY is missing or malformed. Run npm run fork:deploy first.");
}
if (!SVROUTER_ADDRESS) {
  die("NEXT_PUBLIC_SVROUTER_ADDRESS is empty. Run npm run fork:deploy first.");
}

const transport = http(rpcUrl);
const account = privateKeyToAccount(privateKey as Hex);
const publicClient = createPublicClient({ chain: robinhoodChain, transport });
const walletClient = createWalletClient({ account, chain: robinhoodChain, transport });
const testClient = createTestClient({ chain: robinhoodChain, mode: "anvil", transport });
const quoter = createQuoter({ client: publicClient });

/**
 * Brief-vs-reality, proven live on 18 Sep 2026: anvil's own published test accounts — the only
 * keys this harness uses — are the "test test test test test test test test test test test
 * junk" mnemonic's, the most reused test keys in the ecosystem, and on live Robinhood Chain every
 * one of them already carries a real EIP-7702 delegation (`eth_getCode` returns the 23-byte
 * `0xef0100`-prefixed designator, not `0x`), inherited by the fork like any other account state.
 * Permit2's `SignatureVerification` branches on `claimedSigner.code.length`: non-zero sends it
 * down the EIP-1271 path, which calls `isValidSignature` on the delegated code instead of
 * `ecrecover`-checking the signature this script actually produced — and that call reverts before
 * the pool is ever touched (confirmed with `cast run --trace`: the revert is inside Permit2's
 * `isValidSignature` staticcall, 63,944 gas, nowhere near the swap logic). A normal transaction
 * FROM this account (the deploy, the approve) is unaffected — delegation only matters to callers
 * that inspect the account's code — so only the signer needs this, and only on this local fork:
 * `anvil_setCode` to empty clears the inherited delegation without touching the real chain.
 */
await testClient.setCode({ address: account.address, bytecode: "0x" });

/**
 * Give `holder` at least `amount` of `token` by writing the balance mapping directly, the
 * way forge's `deal` does. anvil's accounts hold ETH and nothing else, and the only large
 * holder of these tokens on the fork is the v4 PoolManager, whose balance backs the very
 * pool under test.
 *
 * Brief-vs-reality (proven live on 18 Sep 2026, not assumed): a 32-slot brute force of the
 * Solidity/Vyper mapping formulas — what an earlier version of this script tried — fails for
 * NVDA. `cast code` shows why: NVDA is not a plain ERC-20, it is a hand-rolled beacon proxy
 * (no EIP-1967 slots; the beacon address is baked into the bytecode) that STATICCALLs the
 * beacon for `implementation()` and DELEGATECALLs there, so the balance mapping lives at
 * whatever slot the *implementation* contract's compiler chose in the *proxy's* storage —
 * nowhere near a small index. Forge's own `deal` does not brute-force either: `StdCheats`
 * finds the slot by asking the EVM which one `balanceOf` actually touched.
 *
 * This does the same thing with a standard JSON-RPC call instead of forge's cheatcodes:
 * `eth_createAccessList` (EIP-2930) reports every storage slot a call touches, attributed to
 * the address whose storage trie owns it — for a delegatecall that is the proxy's own address
 * (`token`), which is exactly the slot `anvil_setStorageAt` needs. Verified against this fork:
 * `eth_createAccessList` on NVDA's `balanceOf(PoolManager)` names one slot at NVDA's own
 * address, and writing it changes `balanceOf` to exactly the written value — a clean,
 * unpacked mapping, so the exact-match check below is a real guarantee, not a guess.
 */
async function deal(token: Address, holder: Address, amount: bigint): Promise<void> {
  const held = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  if (held >= amount) return;

  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const { accessList } = await publicClient.request({
    method: "eth_createAccessList",
    params: [{ to: token, data }, "latest"],
  }) as { accessList: { address: Address; storageKeys: Hex[] }[] };
  const ownSlots = accessList.find((e) => isAddressEqual(e.address, token))?.storageKeys ?? [];
  if (ownSlots.length !== 1) {
    throw new Error(
      `balanceOf(${holder}) on ${token} touched ${ownSlots.length} storage slots at the token's own ` +
        "address, not 1; fund the wallet another way",
    );
  }
  const index = ownSlots[0];
  await testClient.setStorageAt({ address: token, index, value: pad(toHex(amount), { size: 32 }) });

  // The access list names the slot a *read* touched; writing the same slot is only correct if
  // nothing else (a packed flag, a second field) shares it. This is the proof, not a hope.
  const now = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  if (now !== amount) {
    throw new Error(
      `wrote slot ${index} on ${token} but balanceOf(${holder}) now reads ${now}, not ${amount}; ` +
        "the slot is not a clean 1:1 balance (packed with something else) — fund the wallet another way",
    );
  }
  console.log(`funded ${token}: balance slot ${index} set to ${amount}`);
}

async function one(
  label: string,
  pool: PoolKeyRow,
  side: Side,
  amount: string,
  denom: Denom,
): Promise<bigint> {
  const priced = await priceSwap(quoter, {
    side,
    amount,
    denom,
    slippageBps: SLIPPAGE_BPS,
    holder: false,
    pool,
  });
  assert.ok(priced.routable, `${label}: the quoter refused the pool (routable: false)`);

  const { call } = priced;
  // Twice the input so the fee, the swap and a second run all fit.
  await deal(call.tokenIn, account.address, BigInt(call.amountIn) * 2n);

  // SwapRequest carries only what executeSwap actually reads (src/lib/swap.ts, post-3875d40):
  // the slippage percentage for its error text, and the call block verbatim. The signer is
  // SwapDeps.account below, the single source of truth — no second copy here.
  const handle = await executeSwap(
    { slippagePct: SLIPPAGE_BPS / 100, call },
    { wallet: walletClient, publicClient, account: account.address },
  );
  const receipt = await handle.confirmation;
  const min = BigInt(call.amountOutMin);
  assert.ok(
    receipt.amountOut >= min,
    `${label}: Trade amountOut ${receipt.amountOut} is below amountOutMin ${min}`,
  );
  // No SUITS_NFT is configured on this deploy (spec decision: no holder discount today), so every
  // trade pays the full 0.5 % router fee on its input, floored the way the contract's integer
  // division floors it — the same formula as `feeFor` in quote/math.ts.
  const expectedFee = (BigInt(call.amountIn) * 50n) / 10_000n;
  assert.equal(
    receipt.fee,
    expectedFee,
    `${label}: Trade fee ${receipt.fee} is not amountIn*50/10000 = ${expectedFee}`,
  );
  assert.equal(receipt.holderRate, false, `${label}: Trade holderRate is ${receipt.holderRate}, expected false`);
  const outDecimals = call.tokenOutDecimals;
  console.log(
    `${label}: in ${toHuman(BigInt(call.amountIn), call.tokenInDecimals)} · ` +
      `quoted ${priced.receiveAmount} · event ${toHuman(receipt.amountOut, outDecimals)} · ` +
      `min ${toHuman(min, outDecimals)} · fee ${toHuman(receipt.fee, call.tokenInDecimals)} · ` +
      `holderRate ${receipt.holderRate} · tx ${handle.hash}`,
  );
  return receipt.amountOut;
}

async function roundTrip(
  ticker: string,
  quoteSymbol: string,
  tokenAddress: Address,
  poolId: Address,
): Promise<void> {
  const backend = getBackend();
  // By the token's own address, not a `pairs("all")` search: see the comment on POOLS above.
  const pair = await backend.pair(tokenAddress.toLowerCase());
  assert.ok(pair, `${tokenAddress} (${ticker}/${quoteSymbol}) is not in the market store`);
  assert.equal(pair.ticker, ticker, `${tokenAddress} is ticker ${pair.ticker}, not ${ticker}`);
  assert.equal(pair.quote, quoteSymbol, `${tokenAddress} quotes ${pair.quote}, not ${quoteSymbol}`);
  const pool = await backend.poolKey(pair.id);
  assert.ok(pool, `${ticker}/${quoteSymbol} has no listed pool`);
  // A pool id is a 32-byte v4 PoolId (keccak256 of the pool key), not a 20-byte address, so this
  // is a plain lowercase compare — `isAddressEqual` rejects it outright (checksum validation on a
  // value that isn't an address).
  assert.equal(
    pool.poolId.toLowerCase(),
    poolId.toLowerCase(),
    `poolKey(${pair.id}) resolved to ${pool.poolId}, not the expected ${poolId} — trading fallback picked a different pool`,
  );

  // Buy one unit of the quote asset's worth, then sell half of what landed.
  const bought = await one(`${ticker}/${quoteSymbol} buy`, pool, "buy", "1", "quote");
  await one(`${ticker}/${quoteSymbol} sell`, pool, "sell", toHuman(bought / 2n, pool.tokenDecimals), "token");
}

try {
  const chainId = await publicClient.getChainId();
  assert.equal(chainId, 4663, `the node at ${rpcUrl} reports chain id ${chainId}, not 4663`);
  for (const { ticker, quote, tokenAddress, poolId } of POOLS) {
    await roundTrip(ticker, quote, tokenAddress, poolId);
  }
  console.log("\nok — both pools bought and sold, every Trade event cleared its amountOutMin");
} catch (err) {
  // SwapUnconfirmedError means the transaction was broadcast but its outcome could not be read —
  // it may well have succeeded. That is not the same claim as a failed assertion or a revert, so
  // it gets its own label rather than being folded into "FAILED" (src/lib/swap.ts's own doc
  // comment on the class: this must never be reported as if nothing was spent). Either way this
  // run cannot complete its proof, so it still exits non-zero.
  const prefix = err instanceof SwapUnconfirmedError ? "UNCONFIRMED" : "FAILED";
  console.error(`\n${prefix}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
