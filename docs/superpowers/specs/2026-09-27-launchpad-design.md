# Token launchpad: presale, then pool — design

> **Phase two, deferred (29 Sep 2026).** Waived for now in favour of the instant launchpad
> (`2026-09-28-instant-launchpad-design.md`). The presale contract would hold every live raise's money at once,
> so it is not revived until MAXLONG pays for an audit and the contract gains a global ceiling on the total held
> across all raises, not only the per-raise cap below. The Decision Log entry drafted at the end is unnumbered:
> D44 now belongs to the holders-only release.

**Date:** 27 Sep 2026. **Status:** draft for Kobe's review. Nothing is built.
**Client basis:** MAXLONG gave the go-ahead on 27 Sep for the model described in
`proposals/2026-09-25-launchpad-estimate.md` (workspace root). The seven questions that document put to
MAXLONG are not yet answered; section 3 gives each a default so the build can start, and every default is a
parameter that can change without touching code paths.

Repos touched: `SuitVenturesMarket-contracts` (two new contracts) and `SuitVenturesMarket-frontend` (reader,
store, two API routes, three screens). Workspace `README.md` gains a Decision Log entry (section 12) when
Kobe approves this spec. Research notes behind the code-facing sections:
`.superpowers/sdd/2026-09-27-launchpad/research/{contracts-repo,v4-mechanics,reader-store,ui-api}.md`.

## 1. What the user gets

**A creator** opens Launch → Create, connects a wallet, names the token, picks the asset to raise in, the
target, an optional floor, a start time and a duration, and signs one transaction. The raise exists from that
moment and has a page. The token and its pool do not exist yet: both are created in the launch transaction,
so nothing about the market can be touched before its liquidity is in place.

**A contributor** opens the raise page, sees progress, time left and their own remaining allowance, and
contributes with one signature plus one transaction. If the raise succeeds they claim their tokens on the same
page. If it fails they take a full refund on the same page.

**Everyone** sees the list of raises at `/launch`: live, upcoming, launched, did not launch. A launched token
appears on the markets table from its launch block, carries the origin badge `SV`, and its token page links
back to the raise.

**MAXLONG** receives the launch fee on every successful raise and a share of every launched pool's trading fees,
forever, both paid to the fee wallet; and controls the settings through an admin key.

Raise states as the screens show them:

| State | Meaning | Raise page shows |
|---|---|---|
| Scheduled | `now < start` | Countdown to open, the terms |
| Open | `start ≤ now < deadline`, not launched, not closed | Progress, contribute panel |
| Launchable | Deadline passed at or above the floor, or target reached, and nobody has launched it yet | "Launch now", a button anyone can press |
| Launched | Token deployed, pool seeded, claims open | "Launched", claim button, link to the token page |
| Did not launch | Deadline passed under the floor, or the stall valve tripped | "Did not reach its floor", refund button |

## 2. The model, and why not a bonding curve

Presale then pool. Everyone who contributes pays the same price, fixed at creation as target divided by the
tokens on sale. Success deploys the token, seeds the pool from the raise and the reserved tokens at exactly
that price, and locks it; failure refunds everyone in full. A bonding curve (Pons, NTRPY Express) was
considered and rejected on 25 and 27 Sep: it is a second market to index, chart and route before the pool
exists, the router has no curve path by design, the contract holding user money is roughly three times the
size, and two of MAXLONG's agreed rules (full refund on failure, fee only on success) have no meaning on a
curve. The cheap form of "instant launch", a one-sided v4 position with no raise, is noted as a possible later
tier and is out of scope here.

Rules MAXLONG agreed in early September, before the launch layer was set aside, all kept:

| Rule | Value |
|---|---|
| Failed raise | Every contributor refunded in full, no fee of any kind |
| Fee | Earned only on success |
| Per-wallet cap | At most 10 % of the raise target per wallet, no minimum |
| Liquidity after launch | Locked, nobody can withdraw |
| Units on chain | Quote-asset units; USD only on screen |
| Raise limits | Smallest and largest raise per asset, set by the admin |

## 3. Decisions with defaults

Each row is a parameter. The first seven are the questions put to MAXLONG; the rest came out of the NTRPY
study and the Uniswap v4 source reading on 27 Sep. "Where" says whether changing it is a setting, a constant
in the deployed contract, or a new deployment.

| # | Decision | Default in this spec | Where |
|---|---|---|---|
| 1 | Who may launch | Anyone with a wallet. A gate contract address can be set later (the Suits NFT); zero means open | Setting `launcherGate` |
| 2 | Launch fee | 2 % of the raise, taken in the quote asset at launch. Admin may set 0 to 5 %; 5 % is a hard cap in code | Setting `feeBps`, constant `MAX_FEE_BPS = 500` |
| 3 | Supply and split | 1,000,000,000 tokens, 18 decimals. 45 % sold in the raise, 45 % reserved for the pool, 10 % to the creator, released linearly over 90 days from launch | Constants |
| 4 | Raise assets | USDG plus the 10 stock tokens with the most 24-hour volume on the table at deploy. Any of the 54 quote assets can be added by a setting | Setting `setQuote` |
| 5 | Raise limits | USD 1,000 to 250,000 equivalent, converted per asset from the Chainlink price at deploy | Setting per asset |
| 6 | Screening and geography | Not in the contracts. The site can hide Create and Contribute by region later. MAXLONG's counsel decides | Out of scope |
| 7 | Audit | Recommended before real launches. The rehearsal in section 10 happens either way | MAXLONG |
| 8 | Floor | The creator may set a floor from 50 % to 100 % of the target; at the deadline a raise at or above its floor launches. Default 100 %, all or nothing | Per raise |
| 9 | Oversubscription | First come, first served. The last contribution is trimmed to what fits; nothing is queued or refunded pro rata | Constant behaviour |
| 10 | Where the raise goes | 100 % of the raise after the fee goes into the pool. The creator receives no quote asset | Constant behaviour |
| 11 | Pool fee and who collects it | LP fee 1 %, tick spacing 200, no hook. Accrued fees are collectable by anyone; 70 % to the creator's payout address, 30 % to the fee wallet, the split fixed per raise at creation | Constants `POOL_LP_FEE`, `TICK_SPACING`; setting `creatorFeeShareBps` read at creation |
| 12 | Opening price | The pool opens at the presale price. Tokens not needed to hold that ratio are burned | Constant behaviour |
| 13 | Timing | Raise length 1 hour to 30 days; start now or up to 14 days ahead | Constants |
| 14 | Stall valve | If a raise is neither launched nor closed 7 days after its deadline, refunds open regardless of the amount raised | Constant `STALL_GRACE = 7 days` |
| 15 | Creator's own buy | No special path. The creator contributes like anyone, under the same cap | Constant behaviour |
| 16 | When the pool is created | In the launch transaction, together with the token and the liquidity, never before | Constant behaviour |

Why 45/45/10 and not the 60/30/10 from the first proposal: the pool must open at the presale price with the
whole net raise in it, so the tokens paired into the pool equal the tokens sold. A 60/30 split would open the
pool at twice the presale price and hand every contributor an instant reason to sell into a pool holding their
own money. The exact 60/30/10 text was never recorded in the workspace; this spec defines the split and flags
it for MAXLONG.

Why the pool is created at launch and not at creation (decision 16): in Uniswap v4 anyone may initialise any
pool key, the price of a pool with no liquidity can be moved for free by a swap against nothing, and anyone
holding the quote asset can add one-sided positions to it. A pool that exists before its liquidity is
therefore a pool whose opening state an outsider can set. Creating the token, initialising the pool and
minting the position in one transaction leaves no such window. The residual is that a party who could see the
launch transaction before it is sequenced could initialise the predicted pool key first and make the launch
revert; the token's address is derived from the block and the caller, so a retry in a later block uses a new
address, and this chain's transactions are not visible before sequencing in any case.

## 4. Contracts

Two contracts in `SuitVenturesMarket-contracts`, alongside `SVRouter`: `SVLaunchToken` and `SVLaunchpad`.
The client estimate described a factory plus one raise contract per launch; this spec merges those into one
singleton because every raise then reports from one address forever, there is no clone or registry, no
separate locker, and one contract is what the audit prices.

**Conventions**, all taken from the router: solc 0.8.26, `cancun`, optimizer as in `foundry.toml`, no
`via_ir`; OpenZeppelin v5 `Ownable2Step` with `renounceOwnership` reverting `RenounceDisabled`,
`ReentrancyGuard`, `SafeERC20`; errors and events declared in the interface `ISVLaunchpad`; setter events
named `<Thing>Changed` and emitted at construction as well; fees in bps over 10,000; the single-token Permit2
`permitTransferFrom` overload; the gate check as a `staticcall` with a 100,000 gas stipend like the router's
Suits check. Dependencies used: v4-core v4.0.0 (`IPoolManager`, `IUnlockCallback`, `PoolKey`, `PoolId`,
`Currency`, `BalanceDelta`, `TickMath`, `FullMath`, `StateLibrary`), v4-periphery's `LiquidityAmounts`
(compiles against the pinned core), OpenZeppelin `ERC20`, `ERC20Burnable`, `Math`. `PositionManager` is not
used and does not compile against the pinned core. One build change: the remapping
`solmate/=lib/v4-core/lib/solmate/` so tests can deploy a local `PoolManager`.

### 4.1 SVLaunchToken

OpenZeppelin `ERC20` plus `ERC20Burnable`. Constructor `(string name, string symbol, uint256 supply,
address recipient)` mints the entire supply to `recipient`, which is always the launchpad. No owner, no mint,
no pause, no blocklist, no transfer fee, 18 decimals. Deployed by the launchpad with `CREATE2`, salt
`keccak256(abi.encode(id, block.number, msg.sender))`, inside the launch transaction.

### 4.2 SVLaunchpad, the singleton

**Constructor** `(IPoolManager poolManager, ISignatureTransfer permit2, address owner, address feeWallet,
uint16 feeBps, uint16 creatorFeeShareBps)`. `ISignatureTransfer` is the Permit2 interface the router
already uses.

**Contract size.** With the token's creation code embedded for `CREATE2`, the launchpad exceeds the 24,576
byte limit at the repo's 1,000,000-run optimizer setting. The two launch source files compile at 200 runs
through a `compilation_restrictions` entry in `foundry.toml`; the router's bytecode is unchanged. The
alternative, a separate token-deployer contract, would keep the profile but add a third deployed contract, and
is not taken.

**Settings** and their bounds:

| Setter | Bounds | Event |
|---|---|---|
| `setFee(uint16 bps)` | `bps ≤ 500` else `FeeTooHigh` | `FeeChanged` |
| `setFeeWallet(address)` | non-zero else `ZeroAddress` | `FeeWalletChanged` |
| `setQuote(address asset, uint256 minTarget, uint256 maxTarget)` | `maxTarget == 0` disables; else `0 < min ≤ max` | `QuoteChanged` |
| `setLauncherGate(address nft)` | zero = open | `LauncherGateChanged` |
| `setCreatorFeeShare(uint16 bps)` | `≤ 10000`; applies to raises created after | `CreatorFeeShareChanged` |
| `setCreationOpen(bool)` | pauses `create` only; never contribute, finalize, claim or refund | `CreationOpenChanged` |

**Constants.**

| Name | Value |
|---|---|
| `SUPPLY` | 1,000,000,000 × 10^18 |
| `SALE_BPS` / `POOL_BPS` / `CREATOR_BPS` | 4500 / 4500 / 1000 |
| `CREATOR_VESTING` | 90 days |
| `WALLET_CAP_BPS` | 1000 (10 % of target) |
| `MIN_FLOOR_BPS` | 5000 |
| `MIN_DURATION` / `MAX_DURATION` | 1 hour / 30 days |
| `MAX_START_DELAY` | 14 days |
| `STALL_GRACE` | 7 days |
| `MAX_FEE_BPS` | 500 |
| `POOL_LP_FEE` | 10000 (1 %) |
| `TICK_SPACING` | 200 |
| `TICK_LOWER` / `TICK_UPPER` | −887200 / 887200, the full range at spacing 200 |

**Per-raise storage**, keyed by a sequential `id` starting at 1:

```
struct Raise {
    address creator;
    address payout;          // receives creator tokens and the creator's fee share; creator may change it
    address quote;
    address token;           // zero until launch
    uint256 target;
    uint256 floor;
    uint64  start;
    uint64  deadline;
    uint256 raised;
    uint256 saleTokens;      // SUPPLY * 4500 / 10000, fixed at creation
    uint256 creatorClaimed;
    uint160 sqrtPriceX96;    // set at launch
    uint128 liquidity;       // set at launch
    uint64  launchedAt;
    uint16  creatorFeeShareBps;
    uint8   status;          // 1 Open, 2 Launched, 3 Closed
    string  name;
    string  symbol;
}
mapping(uint256 id => Raise) raises;
mapping(uint256 id => mapping(address wallet => uint256)) contributed;
mapping(uint256 id => mapping(address wallet => bool)) claimed;
uint256 nextId;
```

`poolTokens` and `creatorTokens` are constants of the supply and are not stored. The pool key is derived,
never stored: `currency0/1` = the lower/higher of token and quote, `fee = POOL_LP_FEE`, `tickSpacing =
TICK_SPACING`, `hooks = address(0)`. A view `poolKey(id)` returns it after launch.

**Functions.**

`create(CreateParams p) returns (uint256 id)` where `CreateParams` = `{name, symbol, image, website, x,
telegram, quote, target, floor, start, duration}`:
1. `creationOpen`; if `launcherGate != 0`, the gate's `balanceOf(msg.sender) > 0` (staticcall, 100,000 gas,
   a failed or short reply counts as zero).
2. Quote enabled; `min ≤ target ≤ max` for that quote; `floor` between `target × 5000 / 10000` and `target`;
   `start == 0` means `block.timestamp`, otherwise `start` in `[now, now + 14 days]`; `duration` in
   `[1 hour, 30 days]`; name 1 to 32 bytes, symbol 1 to 11; `image`, `website`, `x`, `telegram` each at most
   256 bytes.
3. Stores the raise with status Open, `saleTokens = SUPPLY × 4500 / 10000`, the current
   `creatorFeeShareBps`, `payout = msg.sender`; emits `RaiseCreated` and `RaiseMetadata`.

`contribute(uint256 id, uint256 amount, PermitTransferFrom permit, bytes signature)`:
1. Status Open, `start ≤ now < deadline`, `amount > 0`; the permit's token must be the raise's quote
   (`PermitMismatch` otherwise, as the router does).
2. `take = min(amount, target − raised, target × 1000 / 10000 − contributed[id][msg.sender])`; revert
   `RaiseFull` or `WalletCapReached` when zero.
3. Pull `take` of the quote asset through Permit2 `permitTransferFrom` with `requestedAmount = take` (the
   signed amount may exceed it).
4. `raised += take`, `contributed += take`, emit `Contributed(id, wallet, take, raised)`.
5. If `raised == target`, run `_finalize(id)` in the same transaction, so a filled raise is never left waiting
   for someone to launch it. The last contributor pays the launch gas, about one token deployment plus one
   pool initialisation and one position mint, cents on this chain.

`finalize(uint256 id)`: anyone. Requires status Open and either `raised == target` or `now ≥ deadline` with
`raised ≥ floor`. Runs `_finalize`.

`_finalize(id)`:
1. `fee = raised × feeBps / 10000` to the fee wallet; `net = raised − fee`.
2. Deploy `SVLaunchToken(name, symbol, SUPPLY, address(this))` with `CREATE2` and the salt above; store
   `token`.
3. Compute `sqrtPriceX96` for price `target / saleTokens` in raw units (section 4.3); store it;
   `poolManager.initialize(key, sqrtPriceX96)`.
4. `tokensForPool = net × saleTokens / target`, always `≤ SUPPLY × 4500 / 10000` because `net ≤ target`.
   `poolManager.unlock(...)` → in the callback, `modifyLiquidity(key, {TICK_LOWER, TICK_UPPER, +L, salt 0},
   "")` where `L = getLiquidityForAmounts(sqrtPriceX96, sqrtAt(TICK_LOWER), sqrtAt(TICK_UPPER), amount0,
   amount1)` with `net` and `tokensForPool` in currency order; then for each currency with a negative delta:
   `sync`, `transfer` exactly the amount owed, `settle`. The position is owned by the launchpad and no
   function in the contract can ever decrease it: that is the lock.
5. `soldTokens = raised × saleTokens / target`. Burn `(saleTokens − soldTokens) + (poolTokens − tokensUsed)`
   where `tokensUsed` is what the position took. Any quote the position did not use goes to the fee wallet.
6. Status Launched, `launchedAt = now`, `liquidity = L`; emit `Finalized`.

`claim(uint256 id)`: status Launched, not yet claimed, `contributed > 0`. Transfers
`contributed × saleTokens / target` tokens; emits `Claimed`.

`claimCreator(uint256 id)`: status Launched, `msg.sender == creator`. Vested =
`creatorTokens × min(now − launchedAt, 90 days) / 90 days`; transfers `vested − creatorClaimed` to `payout`;
emits `CreatorClaimed`.

`refund(uint256 id)`: requires status Closed, or status Open with (`now ≥ deadline` and `raised < floor`) or
(`now ≥ deadline + STALL_GRACE`). On the first call from status Open: set Closed, emit `Closed(id, raised)`.
Then transfer the caller's contribution back, zero it, emit `Refunded`. Nothing to burn: no token was
deployed.

`collectFees(uint256 id)`: anyone, status Launched. `unlock` → `modifyLiquidity` with `liquidityDelta = 0`
on the same position returns the accrued fees as `feesAccrued` and credits them to the caller's delta; `take`
both currencies into the launchpad; send `× creatorFeeShareBps / 10000` of each to `payout` and the rest to
the fee wallet; emit `FeesCollected`. The only call that ever touches the position after launch, and it
cannot change its liquidity.

`setPayout(uint256 id, address payout)`: creator only, non-zero; emits `PayoutChanged`.

`unlockCallback(bytes)`: callable only by the PoolManager (`NotPoolManager`), and only while the launchpad
itself has an unlock in flight (a transient flag set around each `unlock`, `UnexpectedCallback` otherwise).
The callback data carries the id and an action, mint or collect.

**Guards.** `nonReentrant` on every external state-changing function except `unlockCallback`, which is
reached from inside a guarded call. No `receive`, no native currency anywhere. Quote assets are only those the
admin enabled, so no fee-on-transfer or rebasing token can reach the maths.

**Function signatures**, declared in `ISVLaunchpad`, the single source for both the contracts and the
frontend ABI:

```
struct CreateParams {
    string name; string symbol; string image; string website; string x; string telegram;
    address quote; uint256 target; uint256 floor; uint64 start; uint64 duration;
}
function create(CreateParams calldata p) external returns (uint256 id);
function contribute(uint256 id, uint256 amount,
    ISignatureTransfer.PermitTransferFrom calldata permit, bytes calldata signature) external;
function finalize(uint256 id) external;
function claim(uint256 id) external;
function claimCreator(uint256 id) external;
function refund(uint256 id) external;
function collectFees(uint256 id) external;
function setPayout(uint256 id, address payout) external;

function setFee(uint16 bps) external;
function setFeeWallet(address wallet) external;
function setQuote(address asset, uint256 minTarget, uint256 maxTarget) external;
function setLauncherGate(address nft) external;
function setCreatorFeeShare(uint16 bps) external;
function setCreationOpen(bool open) external;

function getRaise(uint256 id) external view returns (Raise memory);
function contributed(uint256 id, address wallet) external view returns (uint256);
function claimed(uint256 id, address wallet) external view returns (bool);
function nextId() external view returns (uint256);
function feeBps() external view returns (uint16);
function feeWallet() external view returns (address);
function launcherGate() external view returns (address);
function creatorFeeShareBps() external view returns (uint16);
function creationOpen() external view returns (bool);
function quoteLimits(address asset) external view returns (uint256 minTarget, uint256 maxTarget);
function poolKey(uint256 id) external view returns (PoolKey memory);
function poolManager() external view returns (IPoolManager);
function permit2() external view returns (ISignatureTransfer);
```

`getRaise` is an explicit view because a public mapping of a struct holding strings would not return them.

**Events**, every one emitted by the launchpad, declared in `ISVLaunchpad`:

```
event RaiseCreated(uint256 indexed id, address indexed creator, address indexed quote,
    uint256 target, uint256 floor, uint64 start, uint64 deadline, uint256 saleTokens);
event RaiseMetadata(uint256 indexed id, string name, string symbol,
    string image, string website, string x, string telegram);
event Contributed(uint256 indexed id, address indexed wallet, uint256 amount, uint256 raised);
event Finalized(uint256 indexed id, address indexed token, bytes32 indexed poolId,
    uint160 sqrtPriceX96, uint256 raised, uint256 fee, uint256 quoteToPool,
    uint256 tokensToPool, uint256 tokensBurned, uint128 liquidity);
event Closed(uint256 indexed id, uint256 raised);
event Refunded(uint256 indexed id, address indexed wallet, uint256 amount);
event Claimed(uint256 indexed id, address indexed wallet, uint256 amount);
event CreatorClaimed(uint256 indexed id, address indexed payout, uint256 amount);
event FeesCollected(uint256 indexed id, uint256 creator0, uint256 creator1,
    uint256 platform0, uint256 platform1);
event PayoutChanged(uint256 indexed id, address payout);
event FeeChanged(uint16 bps);
event FeeWalletChanged(address wallet);
event QuoteChanged(address indexed asset, uint256 minTarget, uint256 maxTarget);
event LauncherGateChanged(address nft);
event CreatorFeeShareChanged(uint16 bps);
event CreationOpenChanged(bool open);
```

**Errors**, in the interface: `ZeroAddress`, `ZeroAmount`, `FeeTooHigh`, `RenounceDisabled`,
`CreationClosed`, `NotAllowedToLaunch`, `QuoteNotEnabled`, `TargetOutOfRange`, `FloorOutOfRange`,
`StartOutOfRange`, `DurationOutOfRange`, `TextTooLong`, `NotOpen`, `NotStarted`, `Ended`, `RaiseFull`,
`WalletCapReached`, `PermitMismatch`, `NotLaunchable`, `NotLaunched`, `NothingToClaim`, `AlreadyClaimed`,
`NotRefundable`, `NotCreator`, `NotPoolManager`, `UnexpectedCallback`.

### 4.3 Price and liquidity arithmetic

Price is quote per token in raw units, `p = target / saleTokens`, never stored as a fraction. With
`amount0/amount1` meaning the raw amounts of `currency0/currency1` that stand in the ratio `p`:

`sqrtPriceX96 = Math.sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0))`

so with the token as `currency0` it is `sqrt(mulDiv(target, 2^192, saleTokens))` and with the quote as
`currency0` it is `sqrt(mulDiv(saleTokens, 2^192, target))`. This is exact while `amount1 / amount0 <
2^64`; `mulDiv` reverts on overflow and `initialize` reverts outside `[MIN_SQRT_PRICE, MAX_SQRT_PRICE]`,
so a target too small for its asset's decimals fails at launch rather than silently misprices. With
`saleTokens = 4.5 × 10^26` every target between USD 1,000 and 250,000 is in range for 18-decimal and
6-decimal quote assets; the deploy script checks each enabled asset's minimum against these bounds. Because
the token's side of the pair is unknown until its address exists at launch, `create` computes the price in
both currency orders and rejects the raise (`TargetOutOfRange`) if either would overflow or fall outside the
bounds, so a raise can never be created that cannot launch.

Liquidity at launch: `L = LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtAt(−887200),
sqrtAt(887200), amount0, amount1)`. `getLiquidityForAmounts` rounds down and the pool rounds what it takes
up, so the position takes at most the amounts offered plus one unit; the remainder of the token side is burned
and the remainder of the quote side goes to the fee wallet. The full-range per-tick liquidity cap at spacing
200 is about 2^115, far above any launch here. Fork tests assert the pool's `slot0` price equals the stored
`sqrtPriceX96` and the position's liquidity equals `L`.

Claims: `contributed × saleTokens / target` with `mulDiv`; the sum over all contributors is `soldTokens` minus
rounding dust that stays in the launchpad.

### 4.4 Tests

Unit, in the router's style (`test_<snake_case_sentence>`, `testFuzz_`, plain-English assertion messages),
on a `PoolManager` deployed inside the test with the v4-core `Deployers` helpers, real Permit2 etched as the
router tests do, mock ERC-20 quotes at 18 and 6 decimals, and the launch token landing on both sides of the
quote address so both currency orders are covered:

- Full lifecycle: create, contribute from ten wallets (the 10 % cap means no fewer can fill a raise),
  auto-launch on the last contribution, claims, creator vesting at day 0, 45 and 90, `collectFees` after swaps
  through the core's test swap router, the 70/30 split.
- Floor path: deadline passes at 60 % of target with floor 50 %, `finalize` by a stranger, unsold tokens
  burned, pool price equal to the stored `sqrtPriceX96`.
- Failure path: deadline passes under the floor, `refund` closes the raise, every contributor made whole,
  `claim` and `finalize` revert.
- Stall valve: deadline plus 7 days with a mocked PoolManager that reverts on `initialize`; refunds open.
- Caps: the 10 % wallet cap, trimming of the last contribution, `RaiseFull`, contributions before start and
  after deadline revert, zero amount reverts, `PermitMismatch`.
- Admin: every bound in the setter table, the gate with a mock ERC-721 and with a gate that reverts or replies
  short, `setCreationOpen` blocks only `create`, `renounceOwnership` reverts.
- Fuzz: random contribution sequences never exceed target or any wallet's cap; quote held equals the sum of
  open contributions; claims sum to `soldTokens` within dust.
- Invariant: after launch, position liquidity never changes across any sequence of calls.

Fork, against the real PoolManager on chain 4663 with USDG and one stock token, through the existing fork
harness (`ROBINHOOD_RPC_URL`, skipped when unset, pinned block): create, contribute with a real Permit2
signature, finalize, swap through the Universal Router, `collectFees`, and the `Initialize` log in the launch
transaction carrying the expected pool id.

### 4.5 Deployment

`script/DeployLaunchpad.s.sol`, env names `OWNER`, `FEE_WALLET`, `POOL_MANAGER`, `PERMIT2`, `FEE_BPS`,
`CREATOR_FEE_SHARE_BPS`, `QUOTES_JSON`; the script reads the JSON and calls `setQuote` per row. The JSON is
produced by a frontend script, `scripts/launchpad-quotes.mts`: USDG plus the 10 stock tokens with the most
24-hour volume on the table, min and max as raw amounts equal to USD 1,000 and 250,000 at the current
Chainlink price, each checked against the price bounds of section 4.3. The script writes
`launchpad-quotes.json` at the frontend repo root, git-ignored, and the deploy script receives that file's
text in `QUOTES_JSON`, since the contracts repo keeps `fs_permissions` empty. Owner and fee wallet are Kobe's EOA
during the build and MAXLONG's at handover, as for the router. Verification on Blockscout follows the router's
steps; the README's deployment table gains the launchpad's address and block.

## 5. How a raise reaches the screen

The reader already sends one HyperSync request a minute for a block range whose `logs` field is a list of
selections: today one entry, the PoolManager with three topic0 values. The launchpad joins as a second entry,
`{ address: [LAUNCHPAD] }` with no topic filter, at no extra request, and `address` joins the log field
selection so the decoder routes by address and topic0 rather than topic0 alone. The launchpad's logs are
decoded against its ABI, folded in the same pure pass as the PoolManager's, and written by `applyFold` in the
same transaction as the trades and the cursor. A raise can never be ahead of or behind the market data.

The launch transaction emits, in order, the token's mint `Transfer` (not selected), the PoolManager's
`Initialize` and `ModifyLiquidity`, then `Finalized`. Discovery creates the token and pool rows from
`Initialize` as for any pool, with the token's name, symbol and supply read over RPC in the same cycle as
today. The presale part of the fold, applied after the token and pool upserts in the same transaction, sets
`tokens.origin = 'SV'` and marks the launch pool listable, so the token has a page and a table row from its
launch block rather than from its first trade. The raise page flips to launched in the same write.

Events to rows:

| Event | Effect |
|---|---|
| `RaiseCreated` + `RaiseMetadata` | Insert `market.presales` |
| `Contributed` | Upsert `presale_contributions` additive; `presales.raised = event.raised`; `contributors` = rows with `refunded_at = 0` |
| `Finalized` | `presales.token_id`, `pool_id`, `sqrt_price_x96`, `launched_at`, fee, quote and tokens to pool, burned, liquidity; `tokens.origin = 'SV'`; the pool listable |
| `Closed` | `presales.closed_at` |
| `Refunded` | `presale_contributions.refunded_at`; `presales.raised −= amount` |
| `Claimed` | `presale_contributions.claimed_at` |
| `CreatorClaimed`, `FeesCollected`, `PayoutChanged` | `presales.creator_claimed`, `fees_*` running sums, `payout` |

Text fields from `RaiseMetadata` are stored as given, except `image`, which is kept only when it is an
`https:` URL of at most 256 bytes and otherwise stored empty.

## 6. Data

`market.presales`:

| Column | Type | Meaning |
|---|---|---|
| `id` | `int primary key` | The launchpad's raise id |
| `creator`, `payout`, `quote_id` | `text` | Addresses, lower-case |
| `token_id` | `text` | Lower-case token address, empty until launch; same key as `market.tokens` |
| `pool_id` | `text` | Empty until launch |
| `name`, `symbol`, `image`, `website`, `x`, `telegram` | `text` | From `RaiseMetadata` |
| `target`, `floor`, `raised`, `sale_tokens` | `numeric(78,0)` | Raw units |
| `sqrt_price_x96` | `numeric(78,0)` | 0 until launch |
| `start_ts`, `deadline_ts`, `created_ts`, `launched_at`, `closed_at` | `int` | Epoch seconds, 0 when not yet |
| `created_block` | `int` | |
| `contributors` | `int` | Wallets with a live contribution |
| `fee`, `quote_to_pool`, `tokens_to_pool`, `tokens_burned`, `liquidity` | `numeric(78,0)` | From `Finalized`, 0 until then |
| `creator_claimed`, `fees_creator_0`, `fees_creator_1`, `fees_platform_0`, `fees_platform_1` | `numeric(78,0)` | Running sums |
| `updated_at` | `int` | |

Indexes: `(token_id)`, `(deadline_ts)`, `(launched_at)`.

`market.presale_contributions`: `(id int, wallet text, amount numeric(78,0), claimed_at int default 0,
refunded_at int default 0, updated_at int, primary key (id, wallet))`, index `(wallet)`.

Conventions as in the existing migrations: snake_case, lower-case hex ids, `numeric` for raw chain integers
cast to text on read, `int` unix seconds, no foreign keys. One migration file under `supabase/migrations/`,
applied with `npm run db:migrate` over `DATABASE_URL_DIRECT`, which Kobe runs against production.

Status is derived in SQL from these facts and `now`, never stored:

| Status | Rule |
|---|---|
| `launched` | `launched_at > 0` |
| `failed` | `closed_at > 0`, or `deadline_ts ≤ now` and `raised < floor`, or `deadline_ts + 604800 ≤ now` (the stall valve: refunds are open on chain whatever was raised) |
| `launchable` | not launched, not failed, and (`raised = target` or `deadline_ts ≤ now`) |
| `scheduled` | `now < start_ts` |
| `open` | otherwise |

The page therefore shows "did not reach its floor" before the first refund writes `Closed`, "launch now" the
moment a deadline passes above the floor, and the refund button the moment the stall valve opens, never
"launch now" while refunds are already open.

## 7. Serving and screens

**Routes**, in the conventions of the existing routes (`dynamic = "force-dynamic"`, `badRequest` on a bad
id, `cached(data, 5)` on success, `failure(err)` on error, the per-process `ttlCache` memo with a 5-second
TTL, the backend from `getBackend()`):

- `GET /api/launch` returns every raise with derived status, quote symbol and decimals, USD values for target
  and raised through the existing quote-price helper, contributors and time fields, ordered open by soonest
  deadline, then launchable, then scheduled by start, then launched newest first, then failed.
- `GET /api/launch/[id]` returns one raise and, given `?wallet=`, that wallet's contribution row, which is
  public on chain in any case.

There are no write routes: every write is a wallet transaction. The `MarketsDataSource` gains `launches()` and
`launch(id, wallet?)`, with query keys and hooks beside the existing ones in `useMarketsData.ts`; the raise
page polls every 5 s while the status is scheduled, open or launchable.

**Screens**, built from the repo's Tailwind recipes and `ui.tsx` pieces (`Badge`, `Avatar`, `Spinner`) plus
two new small components, a progress bar with a floor marker and a countdown, because neither exists today:

| Screen | Content |
|---|---|
| `/launch` | Four sections: Live, Upcoming, Launched, Did not launch. A card per raise: image, name, symbol, quote, target and raised in USD, progress bar with the floor marked, time left, contributors; a launched card links to `/t/[token]` |
| `/launch/new` | The form: name, symbol, image URL, website, X, Telegram, quote asset, target, floor, start, duration. A live summary panel: opening price, tokens per one unit of quote, pool depth at success, launch fee, per-wallet cap. Create sends one transaction and redirects to `/launch/[id]` read from the `RaiseCreated` log. If a gate is set and the wallet holds no Suits NFT, the form says so instead of failing at signing |
| `/launch/[id]` | Header with image, links and creator; progress, floor, contributors, countdown; the contribute panel: amount, remaining allowance for this wallet, "up to" wording because the last contribution may be trimmed, Permit2 allowance check, sign, send; the wallet's own contribution; Claim, Refund or Launch now by status; a launched raise links to the token page; a failed one explains the floor, or says the launch could not happen within 7 days of the deadline when the raise had met it. A launched raise also shows the creator, when connected, a "Claim creator tokens" button with the amount vested so far, computed from `launched_at`, the 90-day schedule and the running `creator_claimed`; and shows everyone a "Collect fees" button with the totals collected so far, since collection is permissionless and pays the fee wallet's share in the same call |
| Token page | A "Launched on LongMarkets" chip beside the origin badge, linking to `/launch/[id]`, shown when `market.presales` has the token |
| Markets table | The origin badge already prints the origin value uppercased, so `SV` appears with no label map; it gains the tooltip "Launched on LongMarkets" and joins the origin filter options |
| Header | A "Launch" item in the `NAV` list of `TopBar` |

**Wallet writes** live in `src/lib/launch.ts` next to `src/lib/swap.ts` and follow `executeSwap` exactly:
viem `WalletClient` and `PublicClient` from `useWalletClient` and `usePublicClient`, ERC-20 allowance to
Permit2 checked and raised to `maxUint256` when short, the same `permitTypedData` helper and random nonce,
`writeContract` directly, receipt wait, log parse for the id, the same three error classes and the pending,
confirmed, unconfirmed and failed toasts. The ABI is an `as const` array in `src/lib/launch/abi.ts`. The
address is `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS`, named like `NEXT_PUBLIC_SVROUTER_ADDRESS`, read by the browser
and by the reader alike; the reader adds the selection only when it is set.

## 8. Health

`sync.lastCycle` gains `presaleEvents`, the count folded in the cycle. Nothing else changes.

## 9. Costs

| Item | Value |
|---|---|
| Extra HyperSync requests | 0 |
| Extra tables | 2, negligible size |
| Extra crons | 0 |
| Gas to deploy the two contracts | A few dollars |
| Gas per raise creation | One storage write of a struct, cents |
| Gas per launch | One token deployment, one pool initialisation, one position mint, cents |
| Rehearsal funds | USD 50 to 100, mostly recovered |

## 10. Rollout

1. Produce `launchpad-quotes.json` with the frontend script, against the production database.
2. Deploy the launchpad with Kobe's EOA as owner and fee wallet; set the default quotes from the JSON; verify
   on Blockscout; record the address and block in the contracts README.
3. Apply the migration and set `NEXT_PUBLIC_SVLAUNCHPAD_ADDRESS` on Vercel before any raise is created, so no
   launchpad event predates the reader's filter.
4. Rehearsal on the real chain: the admin temporarily lowers USDG's minimum, a test raise is created with a
   small target, two wallets contribute, the raise auto-launches, the token shows on the table with the badge
   and is traded through the site, fees are collected and split, the creator claims vested tokens. Then a
   second raise is left to miss its floor and both wallets take refunds. The minimum is restored.
5. Ownership and fee wallet to MAXLONG at handover.

## 11. Out of scope

Bonding curves; whitelist or NFT pre-rounds; overflow with pro-rata refunds; any creator share of the raise;
contributor vesting; a payout-address change delay or community takeover; image uploads (a URL is stored);
regional blocking; more than one pool per launch; hooks and dynamic fees; the launchpad on the traders board.

## 12. Risks and the Decision Log entry

The launchpad holds contributors' money between contribution and launch; that is the audit question and the
stall valve bounds the worst case to "money returns after 7 days". A raise can fail in public, and the screens
treat that as a normal outcome. Issuing is not listing: MAXLONG is now the party that creates and sells
tokens, which its counsel should see before real launches. Tokens launched here rank on the table by the same
rules as every other token.

Entry to add to the workspace Decision Log on approval, superseding the "no presale, no factory" clause of the
13 Sep scope decision:

> **(unnumbered, deferred) Token launchpad, 27 Sep 2026 (C, K).** MAXLONG gave the go-ahead for a launchpad in the form
> described in the 25 Sep estimate: a fixed-price raise in an allowlisted quote asset that, on success,
> deploys the token, seeds a Uniswap v4 pool at the presale price with the whole net raise and locks it, all
> in one transaction, and on failure refunds every contributor in full. Bonding curves rejected. Two contracts,
> one address indexed, raise data folded in the reader's existing minute request. Defaults pending MAXLONG's
> confirmation: anyone may launch, 2 % launch fee on success, 45/45/10 supply split with the creator's tenth
> released over 90 days, USDG plus the ten deepest stock tokens as raise assets at USD 1,000 to 250,000,
> creator-set floor of 50 to 100 %, LP fee 1 % with collected fees split 70/30 creator/fee wallet. Spec:
> frontend `docs/superpowers/specs/2026-09-27-launchpad-design.md`.
