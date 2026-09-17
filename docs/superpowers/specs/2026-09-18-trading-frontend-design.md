# Trading frontend (M2) — design

Status: approved by Kobe on 18 Sep 2026 ("Go build the trading side").
Spec owner: this document. The plan argues from it; conflicts resolve here.

## 1. What this builds

The four M2 stubs listed in the frontend README become real, and the trade
panel executes a swap through SVRouter on Robinhood Chain (4663):

| Stub today | Becomes |
|---|---|
| `src/lib/swap.ts` fakes a wallet round-trip | Permit2 signature + `SVRouter.swapExactIn`, receipt parsed for the real output |
| `src/hooks/useTokenBalance.ts` returns 1250 / 125000 | `balanceOf` reads for the quote asset and the pair token |
| `localQuote` constant-product approximation | V4 Quoter simulation behind `/api/tokens/{address}/quote` |
| `tradeable: true` for every pool | The same simulation decides, cached per pool (D28) |

Out of scope: watchlist and vote persistence, launchpad links, exact-output
execution, multi-hop routes, gas estimation display, a batch tradeability
prober for the 500-row table.

## 2. Chain facts this design pins

| Fact | Value | Source |
|---|---|---|
| Chain id | 4663 | `src/lib/chain.ts` |
| Universal Router | `0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99` | contracts spec §2 |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical |
| V4 Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | contracts fork suite |
| SVRouter | not deployed; `NEXT_PUBLIC_SVROUTER_ADDRESS` | M2 deploy from Kobe's EOA |
| Router fee | 0.5 % of input, 0 % for Suits holders | contracts spec §5, D34 |

The V4 Quoter and the Universal Router agree to the wei on this chain: the
contracts fork suite asserts it on all three live pools. LONG (Doppler)
tokens report an unlimited Permit2 allowance for every holder, so they never
need an approval transaction; NVDA does, once.

## 3. The quote route

`GET /api/tokens/{address}/quote`

Query parameters, all required except `holder`:

| Name | Shape | Meaning |
|---|---|---|
| `side` | `buy` \| `sell` | buy pays the quote asset, sell pays the token |
| `amount` | decimal string, > 0 | the user's typed number |
| `denom` | `quote` \| `token` | which asset `amount` is denominated in |
| `slippageBps` | integer 1..5000 | the panel's tolerance |
| `holder` | `0` \| `1`, default `0` | Suits NFT holder, decides the fee rate |

The route is `force-dynamic`, `maxDuration = 15`, and never caches a priced
answer. It answers 400 on a malformed parameter, 404 when the token has no
listed pool, 503 when the RPC is unreachable, and 200 with:

```ts
type QuoteResponse = {
  // Display, all decimal strings in human units.
  payAmount: string;        // what leaves the wallet, fee included
  receiveAmount: string;    // the Quoter's number for the net input
  minReceived: string;      // receiveAmount * (1 - slippage)
  routerFeePct: 0 | 0.5;
  routerFeeAmount: string;  // in the pay asset
  poolFeePct: number;       // from the pool's fee tier
  priceImpactPct: number;   // versus the pool's stored price_quote
  // Execution, all base units as decimal strings (uint256-safe).
  call: {
    poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
    zeroForOne: boolean;
    amountIn: string;       // fee included; what Permit2 transfers
    amountOutMin: string;
    tokenIn: Address;
    tokenOut: Address;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  };
};
```

**Why the route owns the pool key.** A PoolKey needs both currencies, the
fee, the tick spacing and the hook address. `TokenPair` carries only
`poolId`, `hook` and a formatted `feeTier`. Rather than widen the shape every
screen consumes, `MarketBackend` gains one method:

```ts
poolKey(tokenId: string): Promise<PoolKeyRow | null>;

type PoolKeyRow = {
  poolId: Address; currency0: Address; currency1: Address;
  fee: number; tickSpacing: number; hooks: Address;
  tokenIsCurrency0: boolean; priceQuote: number;
  tokenAddress: Address; tokenDecimals: number;
  quoteAddress: Address; quoteDecimals: number;
};
```

`dbBackend` reads it from `market.pools` joined to `market.tokens` and
`market.quotes` on the token's `listed_pool_id`. `envioBackend` reads the
same fields from the indexer. Both return `null` when the token has no
listed pool.

**Direction.** `tokenIn` is the quote asset on a buy and the pair token on a
sell. `zeroForOne` is `tokenIn === currency0`.

**Fee first, then the swap.** SVRouter takes its fee off the input and
settles the remainder, so every Quoter call uses the net amount:

```
feeBps   = holder ? 0 : 50
fee      = amountIn * feeBps / 10000        // floor, as the contract does
net      = amountIn - fee
```

**Exact input, both typing directions.** When `denom` names the pay side the
route quotes directly. When it names the receive side it inverts, because the
router is exact-input only:

1. `quoteExactOutputSingle(net' )` for the desired output gives the net input
   the pool needs.
2. Gross that up past the fee: `amountIn = ceil(net' * 10000 / (10000 - feeBps))`.
3. Re-quote `quoteExactInputSingle` with the actual net of that `amountIn`,
   and report *that* as `receiveAmount`. The user sees the amount they will
   really receive, not the amount they typed.

Rounding always favours the pool, never the user's expectation: the gross-up
uses ceiling, the fee uses floor, `amountOutMin` uses floor.

**Simulation, not estimation.** Both quoter functions revert to return their
value, so the route calls them through viem `simulateContract` against the
chain in `src/lib/chain.ts`. A revert that is not the quoter's own return
means the pool cannot be routed: the route answers 200 with
`{ routable: false }` and no `call`, and the panel shows the existing
"Not routed" card.

**Tradeability cache (D28).** The first quote for a pool also records
routability in an in-process TTL cache keyed `routable:{poolId}` for 300 s,
so a token page that reloads does not re-probe. `/api/pairs` keeps
`tradeable: true`; only the token page's panel consults the probe. A batch
prober for the table is M3.

**Price impact** compares the realised rate against `pools.price_quote`
already stored, so no second RPC call.

## 4. The client swap

`src/lib/swap.ts` keeps its `SwapRequest` / `SwapHandle` / `SwapFailedError`
surface so `TradePanel` changes as little as possible, and gains the real
path. The request carries the route's `call` block verbatim: the client never
recomputes amounts.

Order of operations on submit:

1. **Allowance.** `allowance(tokenIn, user, PERMIT2)`. When it is below
   `amountIn`, send `approve(PERMIT2, type(uint256).max)` and wait for the
   receipt. LONG tokens skip this by reporting an unlimited allowance.
2. **Permit2 signature.** EIP-712 `PermitTransferFrom` over
   `{ permitted: { token: tokenIn, amount: amountIn }, spender: SVROUTER,
   nonce, deadline }` with Permit2's own domain (name `Permit2`, chainId
   4663, verifyingContract PERMIT2, no version field). The nonce is 256 random
   bits from `crypto.getRandomValues`: Permit2 nonces are unordered, and a
   collision reverts rather than mis-spending.
3. **Send.** `writeContract` `SVRouter.swapExactIn(params, permit, signature)`
   with `deadline = now + 1200` seconds on both the permit and the params.
4. **Confirm.** `waitForTransactionReceipt`, then read the `Trade` event from
   the receipt's logs for `amountOut`, `fee` and `holderRate`. The confirmed
   toast reports the event's number, not the quote's.

Failures map to messages the panel already renders: a user rejection is
"Cancelled in wallet", a revert whose data decodes to `V4TooLittleReceived`
or `InsufficientOutput` is "Price moved past N% slippage; nothing was spent",
`Expired` is "The quote expired; try again", anything else is "Swap failed.
Nothing was spent." Every message ends with the truth that nothing was spent,
because the router pulls funds only after its checks pass.

**Not configured.** When `NEXT_PUBLIC_SVROUTER_ADDRESS` is empty the panel
renders its existing disabled state with "Trading goes live when the router
is deployed", and the quote route still answers so the numbers are real.

## 5. Balances

`usePairBalances` reads both balances in one `useReadContracts` batch:
`balanceOf(quoteAddress, user)` and `balanceOf(tokenAddress, user)`, scaled
by each asset's decimals. It refetches on block, on window focus, and after
a confirmed swap through a query invalidation. Disconnected returns zeroes,
as today. The panel's "insufficient balance" test and its 25/50/75/100
buttons then work against real numbers; 100 % of the pay asset stays exactly
the balance, since the fee comes out of the input rather than on top.

## 6. Suits holder check

Already real when `NEXT_PUBLIC_SUITS_NFT_ADDRESS` is set. Two changes: the
mock default flips from "holder" to "not a holder", so an unconfigured build
shows the fee every user will actually pay; and the check is passed to the
quote route as `holder`, so the displayed fee and the executed fee come from
one decision.

## 7. Local proof on a fork

`scripts/fork/` gains two scripts so the whole path is exercised without
touching mainnet or waiting on the deploy:

- `anvil.sh` starts `anvil --fork-url <public RPC> --chain-id 4663` and
  prints the funded test accounts.
- `deploy-local.mts` runs the contracts repo's deploy script against that
  anvil, prints the router address, and writes `.env.fork` with
  `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_SVROUTER_ADDRESS` and a funded key for
  the e2e script only.
- `swap-e2e.mts` performs a real buy and a real sell of the AI/NVDA pool and
  the MARIO/NVDA pool through the same code path the browser uses, and
  asserts the `Trade` event matches the quote within slippage.

`.env.fork` is git-ignored and never carries a real key: anvil's own test
keys only.

## 8. Testing

| Layer | What | How |
|---|---|---|
| Quote math | fee floor, gross-up ceiling, slippage floor, inversion | pure functions, a fake quoter |
| Quote route | 400/404/503/200 shapes, `routable: false` | mocked backend + mocked chain client |
| `poolKey` | both backends return the same row for the same token | PGlite for db, fixtures for envio |
| Swap client | allowance skip, permit fields, error mapping | mocked wagmi client, no network |
| Panel | disabled states, holder fee display, confirmed toast from the event | React Testing Library |
| End to end | real buy and sell | anvil fork, `swap-e2e.mts` |

Every existing test keeps passing; the gates stay `npm test`, `npx tsc
--noEmit`, `npx eslint .`, `npm run build`.

## 9. Environment

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_SVROUTER_ADDRESS` | empty until the deploy; empty disables execution only |
| `NEXT_PUBLIC_SUITS_NFT_ADDRESS` | empty falls back to the mock flag, now defaulting to "not a holder" |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | empty keeps browser wallets working, no QR flow |
| `NEXT_PUBLIC_RPC_URL` | empty uses the public endpoint; the fork scripts point it at anvil |

Permit2, the Universal Router and the Quoter are constants in
`src/lib/chain.ts`, not environment variables: they are chain facts, and a
wrong one is a bug rather than a deployment choice.

## 10. Risks

- **The public RPC keeps about 15 minutes of state.** Quoter simulations are
  latest-block reads, so this only bites the fork scripts, which pin a block.
- **A hook can reject a swap that the Quoter accepted**, since the Quoter
  runs the hook too but state can move between the two calls. Slippage covers
  the ordinary case; the error mapping covers the rest.
- **Exact input only** means a user who types the amount to receive gets
  approximately that amount. Section 3 makes the displayed number the honest
  one. Exact-output execution stays a later addition.
