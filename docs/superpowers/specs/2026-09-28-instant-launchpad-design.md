# Instant launchpad: design

**Date:** 29 Sep 2026. **Status:** for Kobe's review. Nothing is built.
**Binding input:** `.superpowers/sdd/2026-09-29-instant-launchpad/brief.md`, every decision Kobe made on 28 and 29 Sep
2026. Where this spec had to settle an engineering detail the brief left open, section 14 lists it. Values marked
DEFAULT are proposals for Kobe and MAXLONG to confirm before the mainnet deploy.
**Research behind the code-facing sections:** `.superpowers/sdd/2026-09-27-launchpad/research/{contracts-repo,
v4-mechanics,reader-store,ui-api}.md` and `.superpowers/sdd/2026-09-29-instant-launchpad/image-upload-research.md`.
Every path, name and line reference to existing code below was checked against the frontend at `ab2d430` and the
contracts repo at `22c114d`.

Repos touched: `SuitVenturesMarket-contracts` gains two contracts, a deploy script and a config file.
`SuitVenturesMarket-frontend` gains one migration, a reader extension, one write route, one page and three
token-page pieces. The workspace `README.md` gains Decision Log entry D47, drafted in section 15.

The deferred presale design, `docs/superpowers/specs/2026-09-27-launchpad-design.md`, is not built. This spec
reuses its reader extension, its SV labelling and its v4 settlement pattern.

## 1. What it is

One transaction, signed by a creator, does everything:

1. deploys a new token with CREATE2: 1,000,000,000 supply, 18 decimals, OpenZeppelin `ERC20` plus
   `ERC20Burnable`, no owner, no mint, no pause, no transfer fee, whole supply minted to the launchpad;
2. initialises its Uniswap v4 pool at the opening valuation the creator picked;
3. places the entire supply as one one-sided position from the opening price to the far end of the price range,
   owned by the launchpad, which has no code path that can ever decrease it. That is the lock;
4. optionally buys the creator a first allocation at the opening price with their own money.

The creator needs no capital: gas only. The creator gets no free tokens and nothing vests. From the launch block the
token has a page, a row on the markets table with the `SV` badge, and is traded through the existing Buy panel and
SVRouter like any other pool. Trading fees earned by the position are collected by anyone and split 70 % to the
launch's payout address and 30 % to the MAXLONG fee wallet.

**What it is not.** No raise, no refunds, no bonding-curve contract and no graduation, no vesting, no list page, no
progress bar, no countdown, no on-chain metadata updates, no image changes after launch, no anti-snipe hook today,
no Suits fee discount. Buys move the price along the position the way a curve would, so the first buyer pays least;
no screen may say that everyone pays the same price.

## 2. Chain facts the design uses

| Item | Value | Source |
|---|---|---|
| Chain | Robinhood Chain, id 4663, Cancun EVM, about 0.1 s blocks | workspace README section 2 |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | same |
| Explorer | `https://robinhoodchain.blockscout.com` | same |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | same; `src/lib/chain/abi.ts:12` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same; `src/lib/chain.ts:70` |
| Universal Router, current | `0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99` | same; `src/lib/chain.ts:73` |
| SVRouter | `0xc9E6b76aA834e746080b1F8Ad6943930eD5147a9`, fee 50 bps | same |
| V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | same |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, fork cross-check only | same |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168`, 6 decimals | same; `quotes.json` |
| NVDA, fork tests | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`, 18 decimals | same |
| The Suits NFT | `0x05c2174aa494bbdf72aeeab0ca3c10216d33b297`, ERC-721, 3,000 supply | same, D44 |
| Quote currencies | 54 rows of `src/lib/chain/math/config/quotes.json`: USDG plus 53 stock tokens; 25 with a USD price, 29 without | counted 29 Sep 2026 |

Pinned libraries: v4-core `v4.0.0`, v4-periphery `3231810e`, OpenZeppelin `5.7.0`, Permit2 `cc56ad0f`, solc
0.8.26, `via_ir` off. The PositionManager is not used: it does not compile against the pinned v4-core and would add a
transferable NFT.

## 3. Price arithmetic

### 3.1 Units

| Symbol | Meaning |
|---|---|
| `S` | Supply, `1_000_000_000e18` raw token units |
| `V` | Opening valuation the creator asks for: raw quote units for the whole supply |
| `V'` | Snapped opening valuation, what the pool actually opens at |
| `T`, `Q` | Token address and quote address |

Price in v4 is currency1 per currency0 in raw units. The pool sorts `currency0 < currency1` by address, so which side
the token is on depends on the token's CREATE2 address, which is known before the launch through the view
`predictToken` (section 4.6).

| Order | currency0 | currency1 | Price in v4 terms | Higher tick means |
|---|---|---|---|---|
| Token first, `T < Q` | token | quote | `V / S` | higher valuation |
| Quote first, `Q < T` | quote | token | `S / V` | lower valuation |

### 3.2 Valuation to sqrtPriceX96 and a tick on spacing 200

1. Sqrt price of the request, rounded toward the lower valuation in each order (amended 29 Sep 2026):
   - token first, rounded down: `sqrtP = Math.sqrt(FullMath.mulDiv(V, 1 << 192, S))`
   - quote first, rounded up: `sqrtP = Math.sqrt(FullMath.mulDivRoundingUp(S, 1 << 192, V), Math.Rounding.Ceil)`.
     In this order a higher price is a lower valuation, so rounding the price up keeps `V'` at or below `V`.
2. `t = TickMath.getTickAtSqrtPrice(sqrtP)`, the greatest tick whose price is at or below `sqrtP`.
3. Snap so the pool never opens above the requested valuation. Solidity's `/` and `%` truncate toward zero, so the
   code handles negative ticks explicitly:
   - token first, `openTick` is `t` rounded toward minus infinity to a multiple of 200. A lower tick is a lower
     valuation.

     ```solidity
     int24 openTick = (t / 200) * 200;
     if (t < 0 && t % 200 != 0) openTick -= 200;
     ```

   - quote first, `openTick` is the smallest multiple of 200 whose `getSqrtPriceAtTick` is at or above `sqrtP`. A
     higher tick is a lower valuation.

     ```solidity
     int24 openTick = (t / 200) * 200;
     if (t > 0 && t % 200 != 0) openTick += 200;   // round toward plus infinity
     if (TickMath.getSqrtPriceAtTick(openTick) < sqrtP) openTick += 200;
     ```

     For a negative `t` truncation already rounds toward plus infinity; the last line catches a `t` that is itself a
     multiple of 200 whose price sits strictly below `sqrtP`.
4. The pool is initialised at exactly `getSqrtPriceAtTick(openTick)`, so its tick is exactly `openTick`.
5. The snapped valuation, rounded down:
   - token first: `V' = FullMath.mulDiv(FullMath.mulDiv(q, q, 1 << 64), S, 1 << 128)` where `q = getSqrtPriceAtTick(openTick)`
   - quote first: `V' = FullMath.mulDiv(FullMath.mulDiv(S, 1 << 96, q), 1 << 96, q)`

`V'` is at or below `V` in both orders and within one tick step of it: 200 ticks are a factor of 1.0001^200, about
2.02 %. Because step 1 rounds the square root toward the lower valuation in both orders, `V' ≤ V` holds exactly,
with no exception. `V'` is what the form shows, what the `Launched` event carries and what the data layer stores.

Worked values, computed with an exact integer replication of `TickMath` (the same one the research notes validated
against `MIN_SQRT_PRICE` and `MAX_SQRT_PRICE`). Both currency orders give the same `V'`, with ticks of opposite sign:

| Quote | Requested | Token-first `openTick` | Snapped `V'` | `V' / V` | Liquidity `L` |
|---|---|---|---|---|---|
| USDG, 6 decimals | $5,000 | −398,400 | $4,995.43 | 0.9991 | 2.24e18 |
| USDG | $10,000 | −391,600 | $9,860.03 | 0.9860 | 3.14e18 |
| USDG | $50,000 | −375,400 | $49,819.60 | 0.9964 | 7.06e18 |
| USDG | $1,000,000 | −345,600 | $980,693.09 | 0.9807 | 3.13e19 |
| USDG | $10,000,000 | −322,400 | $9,978,056.06 | 0.9978 | 9.99e19 |
| 18-decimal stock at $100 | $5,000 | −168,200 | $4,960.58 | 0.9921 | 2.23e23 |
| 18-decimal stock at $100 | $10,000,000 | −92,200 | $9,908,435.19 | 0.9908 | 9.95e24 |
| 18-decimal stock at $1 | $10,000,000 | −46,200 | $9,855,072.17 | 0.9855 | 9.93e25 |

### 3.3 The position

| Order | Range | Pool opens at | State after the mint |
|---|---|---|---|
| Token first | `[openTick, 887200]` | `openTick`, the lower edge | Price sits on the lower edge; the position is active and holds only token0 |
| Quote first | `[−887200, openTick]` | `openTick`, the upper edge | Price sits on the upper edge; the position holds only token1 and turns active the moment the first buy crosses `openTick` |

`887200` and `−887200` are `TickMath.maxUsableTick(200)` and `minUsableTick(200)`. In both orders the position
needs no quote asset: v4's `Pool.modifyLiquidity` charges only currency0 when the tick is at or above the lower
edge and the price equals it exactly, and only currency1 when the tick is at the upper edge. Buying moves the price
into the range; the supply can never be exhausted because the range runs to the far end of v4's price space.

Liquidity for the whole supply, rounded down, with `LiquidityAmounts` imported from
`@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol`, which the research verified compiles under today's
remappings:

- token first: `L = getLiquidityForAmount0(sqrtAt(openTick), sqrtAt(887200), S)`
- quote first: `L = getLiquidityForAmount1(sqrtAt(−887200), sqrtAt(openTick), S)`

The pool rounds what it charges up. Across every row of the table above the amount it charges was at most `S`; the
unplaced remainder is dust and is burned (section 4.5 step 13). Rounding `L` down loses less than one unit of
liquidity, so the dust is at most the token amount one unit of liquidity is worth at the opening price, plus two raw
units for the pool's own rounding (amended 29 Sep 2026):

| Order | Dust bound, raw token units |
|---|---|
| Token first | `ceil(2^96 / sqrtAt(openTick)) + 2` |
| Quote first | `ceil(sqrtAt(openTick) / 2^96) + 2` |

The two are the same number by symmetry, and at most a few hundred million raw units in the table above, under one
billionth of one token. A fuzz test asserts across the whole valuation range that the owed amount never exceeds `S`
and that `S − owed` never exceeds this bound.

`maxLiquidityPerTick` at spacing 200 is `38,350,317,471,085,141,830,651,933,667,504,588`, about 3.8e34. `L` grows
as `S × sqrt(V / S)`, so it reaches the cap near `V = 1.47e42`. The currency setter refuses any bound above
`MAX_VALUATION = 1e36` (amended 29 Sep 2026, down from 1e41), where `L` is about 3.2e31, and below
`MIN_VALUATION = 1e8`, safely above the `S / 2^64` floor where the quote-first `mulDiv` in step 3.2.1 would overflow.
The ceiling is set by the first buy, not the liquidity: `PoolManager.swap` casts `amountSpecified` to `int128`, so a
net first buy above about 1.7e38 raw units reverts `SafeCastOverflow`. The 20 % cap means no first buy that could
succeed costs more than `V' × (1/0.8 − 1) / 0.99 / 0.995`, about 0.254 × `V'`, which at `V' ≤ 1e36` is at most about
2.6e35, three orders of magnitude under the `int128` limit. Real currency bounds peak near 1e25, an 18-decimal stock
at USD 10,000,000 and USD 1 a share.

Any valuation between the two constants therefore gives a legal `sqrtPriceX96`, a tick strictly inside the usable
range (at 1e36 the token-first tick is about 207,200, the quote-first about −207,200), a liquidity under the cap in
both orders and, for any first buy within the cap, an `amountSpecified` inside `int128`, so a launch can never fail
on arithmetic once its currency's bounds are set. A first buy entered above the cap still reverts, but as
`FirstBuyTooLarge`, or for an absurd amount as `SafeCastOverflow` inside the PoolManager; either way nothing moves.

### 3.4 The rule of thumb: about 41 % doubles the price

With the token first and the position running from `P0` to the top, liquidity is `L = S × sqrt(P0)` in real units,
and the quote needed to move the price from `P0` to `P1` is `L × (sqrt(P1) − sqrt(P0))`. So:

| Price move | Quote needed, as a share of the opening valuation `V'` | Tokens bought, share of supply |
|---|---|---|
| × 1.5625 | 25 % | 20 %, the first-buy cap |
| × 2 | `sqrt(2) − 1` = 41.4 % | `1 − 1/sqrt(2)` = 29.3 % |
| × 4 | 100 % | 50 % |
| × 10 | 216 % | 68.4 % |

In general, net quote `y` into the pool buys `S × y / (V' + y)` tokens and leaves the price at `P0 × (1 + y / V')²`.
The pool takes its 1 % fee from the input first, so the gross amount is `y / 0.99`; a trade through SVRouter also
pays the 0.5 % router fee. The quote-first order is the mirror image and gives the same numbers. The form states:
"Buys worth about 41 % of the opening valuation double the price, plus the 1 % pool fee."

## 4. Contracts

Two contracts in `SuitVenturesMarket-contracts`: `src/SVLaunchpad.sol` and `src/SVLaunchToken.sol`, with the
interface `src/interfaces/ISVLaunchpad.sol`. Conventions from SVRouter: `pragma solidity 0.8.26;`, named imports,
`Ownable2Step` with `renounceOwnership` reverting `RenounceDisabled`, OpenZeppelin `ReentrancyGuard` and `SafeERC20`,
every error and event declared in the interface, setter events named `<Thing>Changed` and emitted once by the
constructor with the initial value, bps over 10,000, `// ----` section banners, `@inheritdoc` plus a `@dev` that says
why, no `via_ir`. The one build change is the remapping `solmate/=lib/v4-core/lib/solmate/` so unit tests can deploy a
local `PoolManager`; research verified it compiles.

### 4.1 SVLaunchToken

```solidity
contract SVLaunchToken is ERC20, ERC20Burnable {
    uint256 public constant SUPPLY = 1_000_000_000e18;
    /// Mints the whole supply to `recipient`, always the launchpad. 18 decimals, no owner, no mint after this.
    constructor(string memory name_, string memory symbol_, address recipient) ERC20(name_, symbol_) {
        _mint(recipient, SUPPLY);
    }
}
```

Deployed only by the launchpad, with `new SVLaunchToken{salt: keccak256(abi.encode(msg.sender, p.salt))}(name,
symbol, address(this))`. Mixing the caller into the salt means nobody can land a token at another creator's
predicted address.

### 4.2 ISVLaunchpad: the external surface

```solidity
struct LaunchParams {
    string name;          // 1 to 32 bytes
    string symbol;        // 1 to 11 bytes
    string metadataUri;   // 0 to 128 bytes; the app passes ipfs://<metadata CID>
    address quote;        // an allowed currency
    uint256 valuation;    // requested opening valuation: raw quote units for the whole supply
    uint256 firstBuy;     // gross quote for the creator's first buy, router fee included as in SVRouter; 0 = none
    uint256 minFirstBuyTokens; // floor on the first buy's tokens; the app sets it from its preview minus a tolerance
    address payout;       // receives the creator's fee share; zero means msg.sender; never this contract or the PoolManager
    bytes32 salt;         // picked by the app; CREATE2 salt is keccak256(abi.encode(msg.sender, salt))
    uint256 deadline;     // unix seconds; reverts Expired after it
}

struct Launch {           // one per token; see 4.4 for the packing
    address creator;
    uint64 launchedAt;
    uint16 creatorShareBps;
    bool tokenIsCurrency0;
    address payout;
    int24 openTick;
    address quote;
    address hook;
    uint128 liquidity;
}

struct CurrencyConfig {
    uint256 minValuation; // raw quote units for the whole supply; 0 together with max = 0 means not allowed
    uint256 maxValuation;
    uint256 creationFee;  // raw quote units, pulled through Permit2; 0 today
}

struct LaunchedData {     // the Launched event's payload, one tuple to keep the legacy code generator within stack
    bytes32 poolId;
    address payout;
    address hook;
    bool tokenIsCurrency0;
    int24 openTick;
    uint256 openingValuation; // V', snapped
    uint128 liquidity;
    uint256 tokensInPool;     // what the pool took; S minus the burned dust
    uint256 firstBuyIn;       // net quote swapped into the pool: firstBuy minus routerFee; 0 without a first buy
    uint256 firstBuyTokens;   // tokens the first buy received
    uint256 routerFee;        // quote sent to the fee wallet out of the first buy; firstBuyIn + routerFee is the gross
    uint256 creationFee;      // quote sent to the fee wallet as the creation fee
    uint16 creatorShareBps;
    string name;
    string symbol;
    string metadataUri;
}

struct PendingFees {      // token and quote terms, not currency0/currency1
    uint256 tokenFees;
    uint256 quoteFees;
    uint256 tokenToPayout;
    uint256 quoteToPayout;
    uint256 tokenToFeeWallet;
    uint256 quoteToFeeWallet;
}

// The three activity events the reader indexes. Owner settings each have one <Thing>Changed event below
// (ruling of 29 Sep 2026). `claim` below emits nothing: the reader does not need it, and FeesCollected already
// records every share at collection time, whether it was paid out then or credited to `owed`.
event Launched(address indexed token, address indexed creator, address indexed quote, LaunchedData data);
event FeesCollected(address indexed token, address indexed payout,
    uint256 tokenFees, uint256 quoteFees, uint256 tokenToPayout, uint256 quoteToPayout);
event PayoutChanged(address indexed token, address indexed previous, address indexed payout);

// Setting events, SVRouter's convention: every setter emits, the constructor emits each once
event FeeWalletChanged(address indexed wallet);
event RouterFeeChanged(uint16 bps);
event CreatorShareChanged(uint16 bps);
event FirstBuyCapChanged(uint16 bps);
event DailyLaunchLimitChanged(uint8 limit);
event LauncherGateChanged(address indexed gate);
event HookChanged(address indexed hook);
event CurrencyChanged(address indexed quote, uint256 minValuation, uint256 maxValuation, uint256 creationFee);

// Anyone
function launch(LaunchParams calldata p, ISignatureTransfer.PermitTransferFrom calldata permit,
    bytes calldata signature) external returns (address token);
function collectFees(address token) external;
// Pays msg.sender's whole owed balance in `currency`, credited when a fee delivery failed (4.6), to `to`;
// `to` of address(0), this contract or the PoolManager reverts BadPayout
function claim(address currency, address to) external;
// The launch's current payout address only
function setPayout(address token, address payout) external;
// The PoolManager only, during the launchpad's own unlock. Returns abi.encode(LaunchResult) for Action.Launch and
// abi.encode(uint256 tokenFees, uint256 quoteFees) for Action.Collect
function unlockCallback(bytes calldata data) external returns (bytes memory);

// Owner only
function setFeeWallet(address wallet) external;
function setRouterFee(uint16 bps) external;
function setCreatorShare(uint16 bps) external;
function setFirstBuyCap(uint16 bps) external;
function setDailyLaunchLimit(uint8 limit) external;
function setLauncherGate(address gate) external;
function setHook(address hook) external;
function setCurrency(address quote, uint256 minValuation, uint256 maxValuation, uint256 creationFee) external;

// Views
function getLaunch(address token) external view returns (Launch memory);
function poolKeyOf(address token) external view returns (PoolKey memory);
function uncollectedFees(address token) external view returns (PendingFees memory);
function predictToken(address creator, bytes32 salt, string calldata name, string calldata symbol)
    external view returns (address);
function openingFor(address token, address quote, uint256 valuation)
    external pure returns (int24 openTick, uint160 sqrtPriceX96, uint256 snappedValuation);
function isAllowedLauncher(address account) external view returns (bool);
function launchesToday(address account) external view returns (uint256);
function currency(address quote) external view returns (CurrencyConfig memory);
function owed(address account, address currency) external view returns (uint256);
function launchCount() external view returns (uint256);
function feeWallet() external view returns (address);
function routerFeeBps() external view returns (uint16);
function creatorShareBps() external view returns (uint16);
function firstBuyCapBps() external view returns (uint16);
function dailyLaunchLimit() external view returns (uint8);
function launcherGate() external view returns (address);
function hook() external view returns (address);
function POOL_MANAGER() external view returns (IPoolManager);
function PERMIT2() external view returns (ISignatureTransfer);
```

Custom errors: `ZeroAddress()`, `RenounceDisabled()`, `Expired()`, `NotAllowedToLaunch()`, `DailyLimitReached()`,
`BadName()`, `BadSymbol()`, `UriTooLong()`, `CurrencyNotAllowed()`, `ValuationOutOfRange(uint256 valuation, uint256
min, uint256 max)`, `PermitMismatch()`, `FirstBuyTooLarge(uint256 tokensOut, uint256 cap)`,
`FirstBuyTooSmall(uint256 tokensOut, uint256 min)`, `BadPayout()`, `FeeTooHigh()`, `BpsTooHigh()`,
`BoundsOutOfRange()`, `HookNotAllowed()`, `UnknownLaunch()`, `NotPayout()`, `NothingToCollect()`, `NothingOwed()`,
`NotPoolManager()`, `UnexpectedCallback()`.

The callback's internal types (amended 29 Sep 2026):

```solidity
enum Action { Launch, Collect }
struct LaunchCallback {   // the Action.Launch payload, exactly these fields
    PoolKey key;
    int24 tickLower;
    int24 tickUpper;
    address token;
    address quote;
    bool tokenIsCurrency0;
    uint256 net;              // firstBuy minus routerFee; 0 without a first buy
    address creator;          // msg.sender of launch; receives the first-buy tokens
    uint256 minFirstBuyTokens;
}
struct LaunchResult { uint128 liquidity; uint256 owed; uint256 tokensOut; }
```

Canonical signature of the first event, for its topic0:
`Launched(address,address,address,(bytes32,address,address,bool,int24,uint256,uint128,uint256,uint256,uint256,uint256,uint256,uint16,string,string,string))`.
The frontend's `abi.test.ts` pins all three topic0 values against these signatures, as it does for the PoolManager's.

### 4.3 Constants, constructor, settings

Constants:

| Name | Value |
|---|---|
| `SUPPLY` | `1_000_000_000e18` |
| `POOL_FEE` | `10_000`, 1 % static LP fee |
| `TICK_SPACING` | `200` |
| `MIN_USABLE_TICK`, `MAX_USABLE_TICK` | `−887_200`, `887_200` |
| `MAX_ROUTER_FEE_BPS` | `50`, 0.5 % |
| `MIN_VALUATION`, `MAX_VALUATION` | `1e8`, `1e36` raw quote units (amended 29 Sep 2026, 3.3) |
| `MAX_NAME_BYTES`, `MAX_SYMBOL_BYTES`, `MAX_URI_BYTES` | `32`, `11`, `128` |
| `GATE_CHECK_GAS` | `100_000`, as SVRouter's `HOLDER_CHECK_GAS` |

Constructor: `constructor(IPoolManager poolManager_, ISignatureTransfer permit2_, address owner_, address
feeWallet_, address launcherGate_)`. Zero `owner_`, `feeWallet_`, `poolManager_` or `permit2_` reverts `ZeroAddress`;
a `feeWallet_` equal to the launchpad's own address or `poolManager_` reverts `BadPayout` (amended 29 Sep 2026),
the owner checked inside the `Ownable` argument as SVRouter does. `launcherGate_` may be zero. It sets the values
below and emits every setting event once, then no `CurrencyChanged`: currencies are added by the deploy script.

| Setting | Setter | Initial | Bounds, else revert | Event |
|---|---|---|---|---|
| `feeWallet` | `setFeeWallet` | constructor argument | non-zero, `ZeroAddress`; not `address(this)` or `POOL_MANAGER`, `BadPayout` (amended 29 Sep 2026: a delivery to itself would leave funds outside `_owed` and break the balance invariant of 4.6) | `FeeWalletChanged` |
| `routerFeeBps` | `setRouterFee` | 50 | at most 50, `FeeTooHigh` | `RouterFeeChanged` |
| `creatorShareBps` | `setCreatorShare` | 7,000 | at most 10,000, `BpsTooHigh`; fixed into each launch at launch time | `CreatorShareChanged` |
| `firstBuyCapBps` | `setFirstBuyCap` | 2,000 | at most 10,000, `BpsTooHigh`; 0 blocks any first buy | `FirstBuyCapChanged` |
| `dailyLaunchLimit` | `setDailyLaunchLimit` | 5 | any `uint8`; 0 stops new launches entirely and is the launchpad's only pause | `DailyLaunchLimitChanged` |
| `launcherGate` | `setLauncherGate` | constructor argument, the Suits NFT at deploy | any address; zero means anyone may launch | `LauncherGateChanged` |
| `hook` | `setHook` | zero | zero, or a hook address as section 4.9 requires, else `HookNotAllowed`; applies to later launches only | `HookChanged` |
| currency map | `setCurrency` | empty, filled by the deploy script | quote non-zero, `ZeroAddress`; `max = 0` disallows and clears the row; otherwise `MIN_VALUATION ≤ min ≤ max ≤ MAX_VALUATION`, else `BoundsOutOfRange`; any creation fee | `CurrencyChanged` |

Collection, payout changes and existing launches are never affected by any setting except `feeWallet`, which is read
at each collection.

### 4.4 Storage layout

| Slot | Contents |
|---|---|
| 0 | `Ownable._owner` |
| 1 | `Ownable2Step._pendingOwner` |
| 2 | `feeWallet` (20 bytes), `routerFeeBps` (2), `creatorShareBps` (2), `firstBuyCapBps` (2), `dailyLaunchLimit` (1) |
| 3 | `launcherGate` |
| 4 | `hook` |
| 5 | `launchCount` |
| 6 | `mapping(address quote => CurrencyConfig) _currencies`, three slots per entry |
| 7 | `mapping(address token => Launch) _launches`, five slots per entry: `creator, launchedAt, creatorShareBps, tokenIsCurrency0` / `payout, openTick` / `quote` / `hook` / `liquidity` |
| 8 | `mapping(address account => DayCount) _days`, `DayCount { uint64 day; uint8 count; }` in one slot |
| 9 | `mapping(address account => mapping(address currency => uint256)) _owed`, fee shares whose delivery failed (4.6) |
| namespaced | OpenZeppelin 5.7's `ReentrancyGuard` status, at its ERC-7201 slot, not in the sequence |
| transient | one boolean, "unlock in flight", through OpenZeppelin `TransientSlot` at `UNLOCKING_SLOT = keccak256(abi.encode(uint256(keccak256("svlaunchpad.unlocking")) - 1)) & ~bytes32(uint256(0xff))`, the ERC-7201 formula, declared as a named constant |

The pool key and the tick range are never stored: `currency0` and `currency1` follow from `tokenIsCurrency0`, the fee
and spacing are constants, the hook is in the launch, the range follows from `openTick` and the order. A launch
exists when `creator` is non-zero.

### 4.5 `launch`: the sequence

`nonReentrant`. Steps in execution order, each with its revert:

1. `block.timestamp > p.deadline` reverts `Expired`.
2. `isAllowedLauncher(msg.sender)` false reverts `NotAllowedToLaunch` (section 4.7).
3. Daily limit: `day = block.timestamp / 1 days`, the UTC day number. If the caller's stored day differs, its count
   restarts at 0. `count >= dailyLaunchLimit` reverts `DailyLimitReached`. Store `day` and `count + 1`.
4. Text: name length 0 or above 32 bytes reverts `BadName`; symbol 0 or above 11 bytes reverts `BadSymbol`; URI above
   128 bytes reverts `UriTooLong`. Lengths are bytes, not characters.
5. Currency: `maxValuation == 0` reverts `CurrencyNotAllowed`; `valuation` outside `[min, max]` reverts
   `ValuationOutOfRange(valuation, min, max)`. The bounds apply to the requested `V`, so `V'` may sit up to one tick
   step under the minimum.
6. `payout = p.payout == address(0) ? msg.sender : p.payout`. A payout equal to `address(this)` or `POOL_MANAGER`
   reverts `BadPayout` (amended 29 Sep 2026): fees sent there could never be spent.
7. Payment, the router fee taken out of the first buy exactly as SVRouter takes it (amended 29 Sep 2026):
   `routerFee = floor(firstBuy × routerFeeBps / 10_000)`, `net = firstBuy − routerFee` is what gets swapped, and
   `total = firstBuy + creationFee`. When `total > 0`: `permit.permitted.token != quote` or `permit.permitted.amount < total` reverts
   `PermitMismatch`, then `PERMIT2.permitTransferFrom(permit, {to: address(this), requestedAmount: total}, msg.sender,
   signature)`; Permit2 enforces the signature, nonce and deadline with its own errors. The launchpad reads
   `balanceOf(address(this))` in the quote before and after the pull and reverts `PermitMismatch` unless the increase
   equals `total` exactly (amended 29 Sep 2026): the contract can hold credited `owed` balances between transactions,
   so a fee-on-transfer quote must never be able to pay a creation fee out of them. 8.1 covers this with the
   fee-on-transfer mock on a creation-fee-only launch. When `total == 0` the permit
   and signature are ignored and nothing is pulled, so a free launch needs no approval and no signature.
8. Deploy the token with CREATE2 as in 4.1. A second launch by the same wallet with the same salt, name and symbol
   collides and reverts inside the deployment.
9. `tokenIsCurrency0 = token < quote`; `(openTick, sqrtPriceX96, V') = _opening(token, quote, valuation)` as in 3.2;
   build the key `{currency0, currency1, POOL_FEE, TICK_SPACING, hook}` with the current `hook` setting.
10. `POOL_MANAGER.initialize(key, sqrtPriceX96)`. If anyone initialised this key first, v4 reverts
    `PoolAlreadyInitialized()` and the whole launch reverts; section 10 covers the retry.
11. Set the transient flag, `POOL_MANAGER.unlock(abi.encode(Action.Launch, LaunchCallback{key, tickLower, tickUpper,
    token, quote, tokenIsCurrency0, net, creator: msg.sender, minFirstBuyTokens}))`, clear the flag, decode the
    returned `LaunchResult`. Inside the callback:
    1. `msg.sender != POOL_MANAGER` reverts `NotPoolManager`; flag unset reverts `UnexpectedCallback`.
    2. `L` as in 3.3. `modifyLiquidity(key, {tickLower, tickUpper, int256(uint256(L)), bytes32(0)}, "")`. The token
       side of the returned `callerDelta` is negative: `owed = −tokenDelta`. The quote side is zero by the maths of 3.3
       and is never settled, so if it were not zero the unlock would fail `CurrencyNotSettled`.
    3. If `net > 0`: `swap(key, {zeroForOne: !tokenIsCurrency0, amountSpecified: −int256(net),
       sqrtPriceLimitX96: tokenIsCurrency0 ? MAX_SQRT_PRICE − 1 : MIN_SQRT_PRICE + 1}, "")`. The limit is the far end
       because the position covers it; the pool charges its 1 % LP fee from the input, and that fee accrues to the
       launchpad's own position, so 70 % of it comes back to the payout address at the first collection.
       `tokensOut` is the token side of the returned delta. `tokensOut > SUPPLY × firstBuyCapBps / 10_000` reverts
       `FirstBuyTooLarge(tokensOut, cap)`; `tokensOut < minFirstBuyTokens` reverts `FirstBuyTooSmall(tokensOut, min)`
       (added 29 Sep 2026), which protects the creator if a setting or the currency order differs from what the form
       previewed. Without a first buy, `minFirstBuyTokens` must be 0 or the same check reverts.
    4. Settle the token: `sync(token)`, `transfer(POOL_MANAGER, owed)`, `settle()`.
    5. If `net > 0`, settle the quote: `sync(quote)`, `safeTransfer(POOL_MANAGER, net)`, `settle()`. Exactly `net`,
       never the open delta, as SVRouter's security review ruled: if the swap consumed less, the pool would owe the
       launchpad a positive balance and the unlock reverts `CurrencyNotSettled`, so a partial fill cannot happen
       silently.
    6. If `tokensOut > 0`: `take(token, creator, tokensOut)`, where `creator` is the payload's field, the wallet that
       called `launch` and paid. Inside the callback `msg.sender` is the PoolManager, which is why the payload carries
       the creator (amended 29 Sep 2026).
    7. Return `abi.encode(LaunchResult{L, owed, tokensOut})`.
12. If `routerFee + creationFee > 0`: one `safeTransfer` of the sum in the quote to `feeWallet`. This transfer is in
    the launch itself, so a fee wallet that refuses it makes launches revert until the owner changes it; nothing
    already launched is affected.
13. `dust = SUPPLY − owed`; if `dust > 0`, `SVLaunchToken(token).burn(dust)`. The launchpad now holds none of the token.
14. Store the `Launch` with `launchedAt = block.timestamp` and the current `creatorShareBps`, increment `launchCount`,
    emit `Launched`, return `token`.

Steps 12 to 14 live in one internal function taking a memory struct, so `launch` stays within the legacy code
generator's stack. The order puts every cheap check before any transfer, and the payment pull before any deployment,
so a failed permit wastes no deployment gas. `launch` has no `payable` and no native path; every quote is an ERC-20 from the
allowlist.

### 4.6 The other functions

**`collectFees(token)`**, anyone, `nonReentrant`:

1. Unknown token reverts `UnknownLaunch`.
2. Unlock with `Action.Collect`. In the callback, the same two guards, then `modifyLiquidity(key, {tickLower, tickUpper,
   0, bytes32(0)}, "")`. This is v4's documented poke: with a zero `liquidityDelta` the position's liquidity is
   untouched and the returned `callerDelta` is exactly the fees owed since the last checkpoint, which the pool
   checkpoints so they cannot be paid twice.
3. Both amounts zero reverts `NothingToCollect`. Otherwise, still inside the callback, for each non-zero amount:
   read `balanceOf(address(this))`, `take(currency, address(this), amount)`, read it again, and keep the measured
   increase, after minus before (amended 29 Sep 2026). A fee-on-transfer quote delivers less than it was asked for,
   and splitting the requested amount would pay out balance that belongs to earlier credited shares. Return
   `abi.encode(measuredTokenFees, measuredQuoteFees)`.
4. After the unlock, for each currency with measured amount `a`: `toPayout = floor(a × creatorShareBps / 10_000)`,
   `toFeeWallet = a − toPayout`. The fee wallet takes the rounding dust of the split. The pool's own `mulDiv` in
   `Position.update` truncates each collection's fees to whole units, and the fraction below one unit is lost to the
   position as dust, never carried to the next collection (amended 29 Sep 2026).
5. Deliver each non-zero share with a low-level `transfer(address,uint256)` call that accepts either no return data or
   a `true` word, the same rule as v4's `CurrencyLibrary.transfer`. When the call reverts or returns anything else,
   `_owed[recipient][currency] += share` instead, and the recipient takes it later with `claim(currency, to)`. So a
   payout address a token refuses cannot freeze the fee wallet's share, a fee wallet that refuses cannot freeze a
   creator's share, and the owner cannot freeze creators by pointing `feeWallet` somewhere hostile (ruling of 29 Sep
   2026). The launchpad holds only credited shares between a failed delivery and its claim.
6. Emit `FeesCollected(token, payout, tokenFees, quoteFees, tokenToPayout, quoteToPayout)` with the measured amounts
   of step 3 and the split of step 4. The event records the split whether each share was delivered or credited; no
   other event is emitted.

Invariant, per currency: the launchpad's balance equals the sum of `_owed` over all accounts. Measuring in step 3 is
what keeps it true for a fee-on-transfer quote.

**`claim(currency, to)`**, anyone, `nonReentrant` (amended 29 Sep 2026): `to` equal to `address(0)`, `address(this)`
or `POOL_MANAGER` reverts `BadPayout`; `_owed[msg.sender][currency] == 0` reverts `NothingOwed`; otherwise zero the
balance, then `safeTransfer` it to `to`. Sending to another address is what rescues a recipient the token itself
refuses, since a retry to the same address would fail the same way. A claim is not an activity event the reader
needs, since the collection already recorded the amount, so it emits nothing. The token page shows an owed balance
from the view `owed(account, currency)` with a Claim button (7.3).

**`setPayout(token, payout)`**: unknown token reverts `UnknownLaunch`; `msg.sender != launch.payout` reverts
`NotPayout`, so only the current payout address can move it, and the creator loses that right once they hand it on;
zero reverts `ZeroAddress`; `address(this)` or `POOL_MANAGER` reverts `BadPayout`; emits `PayoutChanged(token,
previous, payout)`.

**`uncollectedFees(token)`**: unknown token reverts `UnknownLaunch`. With v4-core's `StateLibrary` over the
PoolManager, it mirrors `Position.update` exactly:

```solidity
(uint128 liq, uint256 last0, uint256 last1) =
    POOL_MANAGER.getPositionInfo(poolId, address(this), tickLower, tickUpper, bytes32(0));
(uint256 inside0, uint256 inside1) = POOL_MANAGER.getFeeGrowthInside(poolId, tickLower, tickUpper);
unchecked {
    fees0 = FullMath.mulDiv(inside0 - last0, liq, FixedPoint128.Q128); // wrap-around is expected, as in Position.update
    fees1 = FullMath.mulDiv(inside1 - last1, liq, FixedPoint128.Q128);
}
```

then maps currency0 and currency1 to token and quote and applies the split of step 4. A collection in the same
block returns the same numbers. `StateLibrary` reads the PoolManager's storage at `POOLS_SLOT = 6`, the v4.0.0
layout; the fork suite proves the deployed manager matches by comparing this view with an actual collection and
with StateView.

**`predictToken(creator, salt, name, symbol)`**: `Create2.computeAddress(keccak256(abi.encode(creator, salt)),
keccak256(abi.encodePacked(type(SVLaunchToken).creationCode, abi.encode(name, symbol, address(this)))))`. The form calls
it to learn the currency order before the launch.

**`openingFor(token, quote, valuation)`**: the pure arithmetic of 3.2, the same internal function `launch` uses.
Reverts `ValuationOutOfRange(valuation, MIN_VALUATION, MAX_VALUATION)` outside the constants.

**`launchesToday(account)`**: the stored count when the stored day is today, else 0.

### 4.7 The launcher gate

`isAllowedLauncher(account)`: `true` when `launcherGate == address(0)`. Otherwise a raw
`launcherGate.staticcall{gas: GATE_CHECK_GAS}(abi.encodeCall(IERC721.balanceOf, (account)))`, and the answer is
`ok && reply.length == 32 && abi.decode(reply, (uint256)) > 0`. SVRouter uses the same read with the opposite
failure rule; here a codeless gate, a revert, a reply of another length or a call that runs out of its gas allowance
all mean not allowed. A broken gate stops launches; it can never let a non-holder through. The owner's remedy is
`setLauncherGate`. The upload route calls this same view, so the server applies exactly the contract's rule.

### 4.8 Reentrancy and callbacks

`nonReentrant` on `launch`, `collectFees` and `claim`. Fee shares are delivered only after the unlock has returned.
Each delivery is a low-level call that forwards all remaining gas; its failure is caught and only credits `_owed`,
and nothing about the call is bounded beyond that (amended 29 Sep 2026). `unlockCallback` is reached from inside
those guarded calls and is protected by the PoolManager check plus the transient flag, so a direct call from anyone
but the PoolManager, or the PoolManager calling with no launch in flight, reverts. The contracts that receive calls during a launch are the PoolManager, Permit2, the new
token, which is ours and has no hooks, and the quote token, which is on the owner's allowlist; the stock tokens and
USDG have no transfer callbacks. `setPayout` changes one storage word and calls nothing. A fee-on-transfer or
rebasing quote (amended 29 Sep 2026):

- a launch that moves the quote fails closed. If the tax hits the pull, step 7's measured check reverts
  `PermitMismatch`; if it hits only the transfer into the PoolManager, the exact settle of step 11.5 reverts
  `CurrencyNotSettled`, as in SVRouter;
- a free launch, no first buy and no creation fee, succeeds, because it never moves the quote;
- collections on such a pool split what actually arrives, step 3 of `collectFees`.

### 4.9 The hook setting

Zero today, and the launchpad's pools are hookless. `setHook(h)` accepts zero, or an address that has code
(`h.code.length > 0`, added 29 Sep 2026), passes `Hooks.isValidHookAddress(IHooks(h), POOL_FEE)` and carries neither `AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG` nor
`AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG`, else `HookNotAllowed`. The two refused flags would let a hook change what
the position pays at the mint or skim what it collects. Amended 29 Sep 2026 after the security audit: `setHook` also
refuses `BEFORE_REMOVE_LIQUIDITY_FLAG`, `AFTER_REMOVE_LIQUIDITY_FLAG`, `BEFORE_SWAP_RETURNS_DELTA_FLAG` and
`AFTER_SWAP_RETURNS_DELTA_FLAG`. v4 routes the launchpad's zero-delta poke through the remove-liquidity hooks, so a
hook with those flags could freeze fee collection forever for every launch made under it, and a swap returns-delta
hook could skim every trade including the first buy. A legitimate anti-snipe hook needs none of them. A future hook
must also:

- allow the launchpad's own mint, where the hook sees the launchpad as `sender`;
- accept empty `hookData`;
- work with the static 1 % fee. A hook that needs a dynamic fee needs `POOL_FEE = 0x800000` and therefore a new
  launchpad;
- not take an input-side delta on a swap, or the exact settle of step 11.5 makes every first buy revert.

It applies only to launches after the change; a launch's hook is in its pool key forever.

### 4.10 Front-run griefing

Anyone can compute a pending launch's token address with `predictToken` and initialise that pool key first, at any
price, because v4 lets anyone initialise any key, even for an address with no code yet. The launch then reverts at
step 10 and costs the creator gas only; the form picks a new salt, which gives a new token address and a new key, and
the creator presses Launch again. An attacker cannot learn the random 32-byte salt before the transaction is
sequenced, and Robinhood Chain's sequencer does not show pending transactions. Accepted, documented, not defended.

A related effect, cosmetic only: below the opening price there is no liquidity, so a sell before anyone has bought
moves the price down for free and receives nothing. The next buy moves back through the empty range for free and
pays the opening price again. The reader already ignores zero-amount swaps (`fold.ts`, `handleSwap`), so this leaves
no trade or candle behind.

### 4.11 Contract size

The launchpad embeds the token's creation code for CREATE2. The plan's first build task runs `forge build --sizes`.
If `SVLaunchpad` exceeds 24,576 bytes at the repo's 1,000,000-run optimizer setting, `foundry.toml` gains an
`additional_compiler_profiles` entry with `optimizer_runs = 200` and a `compilation_restrictions` entry that pins the
launch source files to it, leaving SVRouter's bytecode unchanged (amended 29 Sep 2026: both keys are needed).

Stack depth: with `via_ir` off, a stack-too-deep error in `launch` is resolved as SVRouter resolved its own, by moving
the post-unlock steps 12 to 14 into an internal function that takes a memory struct, and carrying the callback's
inputs and outputs in `LaunchCallback` and `LaunchResult`.

## 5. Data

### 5.1 Migration `supabase/migrations/20260929000000_launches.sql`

House conventions: snake_case, lower-case hex ids as `text`, raw chain integers as `numeric` read back as text,
`int` unix seconds, enumerations as `text` with a check, no foreign keys. Applied with `npm run db:migrate`.

```sql
-- Instant launchpad (spec 2026-09-28-instant-launchpad-design.md, section 5). Additive: three new tables and one index.

create table market.launches (
  token_id text primary key,                 -- lower-case token address, the key of market.tokens
  pool_id text not null,
  quote_id text not null,
  creator text not null,
  payout text not null,
  token_is_currency0 boolean not null,
  creator_share_bps int not null check (creator_share_bps between 0 and 10000),
  open_tick int not null check (open_tick % 200 = 0),
  opening_valuation numeric not null,        -- V', raw quote units for the whole supply
  liquidity numeric not null,
  tokens_in_pool numeric not null,
  first_buy_in numeric not null,
  first_buy_tokens numeric not null,
  router_fee numeric not null,
  creation_fee numeric not null,
  hook text not null,
  name text not null,
  symbol text not null,
  metadata_uri text not null,
  metadata_cid text not null default '',     -- from metadata_uri when it is ipfs://<cid>, else ''
  image_cid text not null default '',        -- the rest copied from market.launch_uploads, '' without a match
  description text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  launch_block int not null,
  launch_log_index int not null,
  launch_tx text not null,
  launched_at int not null,
  -- No fee totals here (amended 29 Sep 2026): they are summed on read from market.launch_fee_events (5.5).
  payout_block int not null,                 -- the last PayoutChanged applied, as (block, log index)
  payout_log_index int not null,
  hidden boolean not null default false,     -- moderation: no image, description or links anywhere
  updated_at int not null,
  check (opening_valuation > 0 and liquidity > 0 and tokens_in_pool > 0),
  check (first_buy_in >= 0 and first_buy_tokens >= 0 and router_fee >= 0 and creation_fee >= 0)
);
create index launches_creator on market.launches (creator);
create index launches_metadata_cid on market.launches (metadata_cid) where metadata_cid <> '';

-- One row per FeesCollected log (amended 29 Sep 2026): the primary key makes a re-applied batch a no-op. Fee totals
-- are never stored; the single-token read sums this table through launch_fee_events_token.
create table market.launch_fee_events (
  tx_hash text not null,
  log_index int not null,
  token_id text not null,
  payout text not null,
  token_payout numeric not null check (token_payout >= 0),
  token_platform numeric not null check (token_platform >= 0),
  quote_payout numeric not null check (quote_payout >= 0),
  quote_platform numeric not null check (quote_platform >= 0),
  block int not null,
  ts int not null,
  primary key (tx_hash, log_index)
);
create index launch_fee_events_token on market.launch_fee_events (token_id, ts desc);

create table market.launch_uploads (
  id bigint generated always as identity primary key, -- one row per accepted upload, so every one counts
  wallet text not null,
  image_cid text not null,
  metadata_cid text not null,
  image_key text not null,                   -- Filebase object keys, for the orphan clean-up
  metadata_key text not null,
  name text not null,
  symbol text not null,
  description text not null default '',
  website text not null default '',
  x text not null default '',
  telegram text not null default '',
  -- 'refused': pinned, then refused by the locked recount (section 6 step 12); not counted, cleaned like 'pending'
  status text not null default 'pending' check (status in ('pending', 'used', 'deleted', 'refused')),
  created_at int not null,
  used_at int not null default 0,
  token_id text not null default ''
);
create index launch_uploads_wallet_created on market.launch_uploads (wallet, created_at desc);
create index launch_uploads_metadata_cid on market.launch_uploads (metadata_cid);
create index launch_uploads_image_cid on market.launch_uploads (image_cid);
create index launch_uploads_cleanable on market.launch_uploads (created_at) where status in ('pending', 'refused');

-- The markets table now orders by coalesce(last_swap_at, created_at) so an unswapped launch in its first 24 hours
-- is not cut off (5.4).
create index if not exists pools_activity on market.pools ((coalesce(last_swap_at, created_at)) desc);

-- Backs the per-cycle query for SV pools whose 24-hour listing window has closed (5.4).
create index pools_sv_unswapped on market.pools (created_at) where origin = 'SV' and swap_count = 0;
```

### 5.2 Reader

**Address.** A new module `src/lib/launch/address.ts` exports `LAUNCHPAD_ADDRESS: Address | undefined`, read from
`NEXT_PUBLIC_LAUNCHPAD_ADDRESS` by direct member access and validated like `SVROUTER_ADDRESS` in
`src/lib/chain.ts:87-89`. The browser and the reader both use it. `HyperSyncSourceOptions` gains `launchpad?: string`
so tests inject it; the default is the module value.

**Query body**, in `fetch` at `src/lib/chain/hypersyncSource.ts:222`:

```ts
logs: [
  { address: [POOL_MANAGER], topics: [[TOPIC0.initialize, TOPIC0.swap, TOPIC0.modifyLiquidity]] },
  ...(launchpad ? [{ address: [launchpad], topics: [[LAUNCH_TOPIC0.launched, LAUNCH_TOPIC0.feesCollected, LAUNCH_TOPIC0.payoutChanged]] }] : []),
],
field_selection: {
  block: ["number", "timestamp"],
  log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"],
  transaction: ["hash", "from"],
},
```

Still one request per cycle. The setting events are left out by the topic filter. `HyperSyncLog` gains `address?:
string | null`, `RawLog` gains `address: string`, lower-cased; a log without an address is dropped. The test at
`hypersyncSource.test.ts:144-166` that pins the body gains the `address` field and a second case with the launchpad
set.

**Decoding**, `src/lib/chain/decode.ts`: dispatch on address, then topic0. The PoolManager's address goes to the
existing three branches unchanged; the launchpad's address goes to a new `decodeLaunchpadLog` against
`LAUNCHPAD_EVENTS_ABI` in `src/lib/chain/abi.ts`, transcribed from `ISVLaunchpad.sol`; any other address returns null.

**New `ChainEvent` kinds**, `src/lib/chain/types.ts`, all addresses lower-case and on-chain integers `bigint` except
ticks and bps:

```ts
export type LaunchedEvent = ChainEventBase & {
  kind: "launched";
  token: string; creator: string; quote: string; poolId: string; payout: string; hook: string;
  tokenIsCurrency0: boolean; openTick: number; openingValuation: bigint; liquidity: bigint; tokensInPool: bigint;
  firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint; creatorShareBps: number;
  name: string; symbol: string; metadataUri: string;
};
export type LaunchFeesEvent = ChainEventBase & {
  kind: "launchFees";
  token: string; payout: string; tokenFees: bigint; quoteFees: bigint; tokenToPayout: bigint; quoteToPayout: bigint;
};
export type PayoutChangedEvent = ChainEventBase & { kind: "payoutChanged"; token: string; previous: string; payout: string };
export type ChainEvent = InitializeEvent | SwapEvent | ModifyLiquidityEvent | LaunchedEvent | LaunchFeesEvent | PayoutChangedEvent;
```

**Fold**, `src/lib/chain/fold.ts`:

1. Before the dispatch loop in `foldEvents`, one pass over `events` collects `svPools: Set<string>` from every
   `launched` event's `poolId`. The launch transaction emits `Initialize`, `ModifyLiquidity`, optionally `Swap`,
   then `Launched`, all in one block, so they always arrive in the same batch; the pre-scan lets `handleInitialize`,
   which runs first, label the pool.
2. `handleInitialize` uses `svPools.has(event.poolId) ? "SV" : originFor(event.poolId, event.hooks)` for the pool's
   origin. A new token takes that origin, as today.
3. `recomputePrimaryPool` keeps D43's ranking for the primary pool, but sets the token's origin to `"SV"` whenever any
   of the token's pools has origin `"SV"`, else to the best pool's origin as today. A token launched here stays SV
   even if someone later opens a second pool with more money in it; that pool then prices the token, which is D43's
   point. `loadFoldState` already loads every pool of every touched token, so this needs no new state.
4. `handleLaunched` appends a `LaunchRow` to the context. If the pool is already in state with another origin, which
   only happens if a launch's `Initialize` fell into an earlier batch, it sets the pool and token to `"SV"` and marks
   both touched.
5. `handleLaunchFees` appends one `LaunchFeesRow` per event, with its transaction hash and log index, never summed in
   the fold (amended 29 Sep 2026); `handlePayoutChanged` keeps the last change per token.
6. Kind guards, because the three launchpad kinds are not all pool events (added 29 Sep 2026):
   - `loadFoldState`, `src/lib/chain/store.ts:129`, builds `poolIds` only from `initialize`, `swap`,
     `modifyLiquidity` and `launched` events; `launched` contributes its `poolId`, so a pool initialised in an
     earlier batch is loaded and can be relabelled SV. `launchFees` and `payoutChanged` contribute nothing.
     `loadCandles` is checked to read only `swap` events.
   - `newTokenCandidates`, `src/lib/chain/fold.ts:236`, skips every event that is not `initialize`, `swap` or
     `modifyLiquidity` before it reads `event.poolId`.
   - the `switch` in `foldEvents` gains the three cases; TypeScript's exhaustiveness check covers the rest.

**`FoldResult` additions**, the eight existing fields unchanged:

```ts
export type LaunchRow = {
  tokenId: string; poolId: string; quoteId: string; creator: string; payout: string; hook: string;
  tokenIsCurrency0: boolean; creatorShareBps: number; openTick: number; openingValuation: bigint; liquidity: bigint;
  tokensInPool: bigint; firstBuyIn: bigint; firstBuyTokens: bigint; routerFee: bigint; creationFee: bigint;
  name: string; symbol: string; metadataUri: string; metadataCid: string;
  block: number; logIndex: number; txHash: string; timestamp: number;
};
export type LaunchFeesRow = {
  txHash: string; logIndex: number; // one row per FeesCollected log, the key of market.launch_fee_events
  tokenId: string; payout: string; tokenPayout: bigint; tokenPlatform: bigint; quotePayout: bigint; quotePlatform: bigint;
  timestamp: number; block: number;
};
export type PayoutRow = { tokenId: string; payout: string; block: number; logIndex: number };

// added to FoldResult
launches: LaunchRow[];
launchFees: LaunchFeesRow[];
payouts: PayoutRow[];
launchEvents: number; // launched + launchFees + payoutChanged events folded, for health
```

`metadataCid` is the part after `ipfs://` when the URI matches `^ipfs://[A-Za-z0-9]{46,128}$`, else `""`.
Platform amounts are the event's total minus its payout amount.

**Store**, `src/lib/chain/store.ts`, inside the same `applyFold` transaction, after `upsertTokensFromFold` and
before `recomputeListedPools` and `saveCursors`, in this order:

1. `insertLaunches(t, result.launches, now)`: `insert ... select ... from unnest(...) on conflict (token_id) do
   nothing`, with `payout_block, payout_log_index` set to the launch's own position.
2. `attachUploads(t, launchTokenIds, now)`: two statements. First, copy the newest matching upload's fields:

   ```sql
   update market.launches l set image_cid = u.image_cid, description = u.description, website = u.website,
     x = u.x, telegram = u.telegram, updated_at = $2::int
   from (select distinct on (metadata_cid) * from market.launch_uploads
         where metadata_cid in (select metadata_cid from market.launches where token_id = any($1::text[]))
         order by metadata_cid, id desc) u
   where l.token_id = any($1::text[]) and l.metadata_cid <> '' and u.metadata_cid = l.metadata_cid
   ```

   Both statements, the upload read in the first included, filter on `u.status <> 'deleted'` (amended 29 Sep 2026):
   a deleted upload's objects are gone, so its fields are not copied and its row is never revived. Such a launch shows
   no image or links, and the health count below makes it visible. Second, mark every live upload with that CID used:

   ```sql
   update market.launch_uploads u set status = 'used', used_at = $2::int, token_id = l.token_id
   from market.launches l
   where l.token_id = any($1::text[]) and l.metadata_cid <> '' and u.metadata_cid = l.metadata_cid
     and u.status = 'pending'
   ```

3. `insertLaunchFees(t, result.launchFees)`, one row per event and nothing else (amended 29 Sep 2026: no totals
   are stored, so there is nothing to keep in step with the rows):

   ```sql
   insert into market.launch_fee_events (tx_hash, log_index, token_id, payout, token_payout, token_platform,
     quote_payout, quote_platform, block, ts)
   select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[],
     $8::numeric[], $9::int[], $10::int[])
   on conflict (tx_hash, log_index) do nothing
   ```

   A re-applied batch inserts nothing, so a total summed on read cannot double (5.5).
4. `applyPayouts(t, result.payouts, now)`: `set payout = u.payout, payout_block = u.block, payout_log_index =
   u.log_index` under `(l.payout_block, l.payout_log_index) < (u.block, u.log_index)`, a last-write-wins that the
   position makes idempotent.
5. The token ids passed to `recomputeListedPools` also include every launch token, plus the tokens of SV pools whose
   24-hour listing window has just closed (5.4).

A throw anywhere rolls back the whole batch with the cursor, as today. Applying the same result twice changes nothing:
the launch insert and the fee insert do nothing on conflict, and the payout update is gated by position.

**Runner and health.** `ChainRunReport` and `finishRun`'s `report` gain `launchEvents`; `lastCycleFrom`
(`src/lib/market/dbBackend.ts:161`) and `HealthReport.sync.lastCycle` (`src/lib/market/backend.ts:18`) gain the
same number. In `lastCycleFrom` the field is optional and reads 0 when absent (amended 29 Sep 2026), so a
`last_report` written before this release still parses and health does not drop `lastCycle`. Health also gains
`launches.missingUploads`, the count of launch rows with a `metadata_cid` but no `image_cid`, which is how a launch
whose upload was already cleaned up shows.

### 5.3 Primary pool

A fresh launch has one pool, so it is the primary pool from its `Initialize`, and its liquidity reads $0 until
someone buys, because liquidity counts the quote side only (D43, `ab2d430`). If a second pool for the same token
appears, D43's ranking by quote-side USD, then swap count, then age, picks the primary as for any token; the token's
origin stays SV by the rule in 5.2.

### 5.4 Listing and ordering

`LISTED_POOL`, `src/lib/sync/writers.ts:165-168`, lets a launchpad pool list without a swap, but only for its first
24 hours (amended 29 Sep 2026, DEFAULT for Kobe to confirm, section 12). Without the window, five launches per wallet
per day could fill the 500-row table with pools nobody trades:

```sql
coalesce(
  (select p.id from market.pools p where p.id = t.primary_pool_id
     and (p.swap_count > 0 or (p.origin = 'SV' and p.created_at > $2::int - 86400))
     and p.price_quote > 1e-24 and p.price_quote < 1e18),
  (select p.id from market.pools p where p.token_id = t.id
     and (p.swap_count > 0 or (p.origin = 'SV' and p.created_at > $2::int - 86400))
     and p.price_quote > 1e-24 and p.price_quote < 1e18
     order by p.swap_count desc, p.last_swap_at desc nulls last, p.id limit 1))
```

`recomputeListedPools(db, tokenIds, now)` gains `now` as a parameter, bound as `$2`, so tests set the clock. Every
caller passes it: `applyFold` its `now`, the nightly "listed" phase its run time. An unswapped launch leaves the table
when its window closes: each `applyFold` also recomputes the tokens returned by

```sql
select token_id from market.pools p join market.tokens t on t.id = p.token_id and t.listed_pool_id = p.id
where p.origin = 'SV' and p.swap_count = 0 and p.created_at <= $1::int - 86400
  and p.created_at > $1::int - 86400 - 259200  -- amended 29 Sep 2026: look back 3 days only, so the per-cycle
                                               -- sweep stays small; the nightly full recompute delists anything older
```

which is empty almost always. A launch that trades within its window stays listed like any traded token. The token
page must keep working after delisting, because the fee panel lives there: the single-token query in `pair(id)`
joins its pool on `coalesce(t.listed_pool_id, l.pool_id)` with a left join on `market.launches l`, so a delisted
launch still has a page and a `launch` block. The 500-row list query is unchanged and does not show it.

Every launchpad price is inside the sane window: the lowest possible is `MIN_VALUATION` in an 18-decimal quote,
about 1e-19 per token.

`ORDER`, `src/lib/market/dbBackend.ts:45`, becomes `order by coalesce(p.last_swap_at, p.created_at) desc, p.id limit
500`, so a launch sorts by its launch time until its first trade and is not pushed off the 500-row cap by older
swapped tokens during its window. Every other listed pool has swapped and has a `last_swap_at`, so their order is unchanged. The
launchpad scope, `dbBackend.ts:49`, becomes `where t.origin in ('LONG', 'Pons', 'SV')`.

### 5.5 The `launch` block on the single-token response

`TokenPair` in `src/lib/types.ts` gains one optional field, filled only by `backend.pair(id)`, never by the 500-row
list:

```ts
export type LaunchInfo = {
  creator: Address;
  payout: Address;
  quoteAddress: Address;
  quoteDecimals: number;
  tokenIsCurrency0: boolean;
  openTick: number;
  /** V', raw quote units for the whole supply, decimal string. */
  openingValuation: string;
  firstBuyIn: string;
  firstBuyTokens: string;
  creatorShareBps: number;
  launchedAt: number;          // unix seconds
  launchBlock: number;
  launchTx: Hex;
  hidden: boolean;
  /** All "" when hidden. */
  imageCid: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
  /** Router fee taken out of the first buy; firstBuyIn + routerFee is the gross the creator paid. */
  routerFee: string;
  /** Summed on read over market.launch_fee_events, raw units, decimal strings; all "0" before any collection. */
  feesCollected: { tokenToPayout: string; tokenToPlatform: string; quoteToPayout: string; quoteToPlatform: string };
  /** Unix seconds of the latest collection, 0 before any. */
  feesCollectedAt: number;
};

// TokenPair
launch?: LaunchInfo | null;   // undefined on list rows, null for a token not launched here
```

`pair(id)` in `dbBackend.ts` runs one more query after the pair query, `select ... from market.launches l join
market.quotes q on q.id = l.quote_id where l.token_id = $1`, with every `numeric` cast to text, and blanks the five
text fields when `hidden`. The fee totals come from one more indexed sum, served by `launch_fee_events_token`
(amended 29 Sep 2026):

```sql
select coalesce(sum(token_payout), 0)::text as token_to_payout, coalesce(sum(token_platform), 0)::text as token_to_platform,
  coalesce(sum(quote_payout), 0)::text as quote_to_payout, coalesce(sum(quote_platform), 0)::text as quote_to_platform,
  coalesce(max(ts), 0) as fees_collected_at
from market.launch_fee_events where token_id = $1
```

The primary key `(tx_hash, log_index)` does not lead with `token_id`, which is why the migration adds that index.
`GET /api/tokens/[address]` and the server-rendered token page already share
`pair:${id}` in the 30-second memo, so both get the block with no route change.

### 5.6 Logo

`src/lib/logos/resolve.ts` gains a first stage before `logo()`: `LogoDeps.launchImage(address)` reads `image_cid,
metadata_uri, hidden` from `market.launches`; a database error is `{ ok: false }`. On `{ ok: false }` the stage sets
`ctx.incomplete = true` and the lookup returns no logo for this request rather than falling through (amended 29 Sep
2026): falling through could answer, and cache, a DexScreener image for a hidden launch. An incomplete answer is never
memoised and gets the route's 60-second cache, as today.

| Launch row | Result |
|---|---|
| none | fall through to the existing stages |
| `hidden` | definite "no logo", so the avatar shows the letter |
| `image_cid` set | candidates: the Filebase gateway first, then `IPFS_GATEWAYS`; `source: "launch"` |
| `image_cid` empty, `metadata_uri` set | fetch the metadata JSON like a LONG `tokenURI` and use its `image` |

`IPFS_GATEWAYS` gains the Filebase gateway first: `FILEBASE_GATEWAY_URL` plus `/ipfs/`, falling back to
`https://ipfs.filebase.io/ipfs/`. For `source: "launch"` the logo route answers with `public, max-age=3600,
s-maxage=3600` instead of the week-long `HIT_CACHE`, and the resolver's memo holds a launch hit for one hour, so a
takedown by setting `hidden` reaches every visitor within the hour.

## 6. Upload route: `POST /api/launch/upload`

`src/app/api/launch/upload/route.ts`, `dynamic = "force-dynamic"`, `maxDuration = 30`, Node runtime. `sharp` is in
Next's default `serverExternalPackages` list and becomes a direct dependency; the Filebase client is `aws4fetch`, a
small SigV4 signer, rather than the AWS SDK.

**Request.** `multipart/form-data`:

| Part | Rule |
|---|---|
| `image` | required file, at most 2,097,152 bytes exactly, PNG, JPEG, WebP or GIF by magic bytes |
| `name` | 1 to 32 bytes of UTF-8, the exact string the launch will pass |
| `symbol` | 1 to 11 bytes |
| `description` | optional, at most 500 characters, no control characters except newline |
| `website` | optional, an `https://` URL of at most 200 characters |
| `x` | optional, a handle of 1 to 15 of `[A-Za-z0-9_]` or an `x.com` or `twitter.com` profile URL; stored as `https://x.com/<handle>` |
| `telegram` | optional, a name of 5 to 32 of `[A-Za-z0-9_]` or a `t.me` URL; stored as `https://t.me/<name>` |

**Response.** `200` with `Cache-Control: no-store`: `{ imageCid: string, metadataCid: string, metadataUri: string }`,
where `metadataUri` is `ipfs://<metadataCid>`. Errors are `{ error: string, code: string }`, all `no-store`.

**Order of checks**, the existing write routes' order of session, then budget, then input, then the store, with
the gate straight after the budget (amended 29 Sep 2026):

| # | Check | Failure |
|---|---|---|
| 1 | `requireSession(req)` | 401 `{ error: "not signed in" }`, the body `requireSession` returns today, or 503 when sessions are not configured |
| 2 | `allowWrite(session.address, now)`, and an upload-only per-IP limiter with its own key space (`upload:` prefix, its own map and cap in `src/lib/social/rateLimit.ts`), so uploads never spend the sign-in routes' `allowClient` budget | 429 via `tooManyRequests()` |
| 3 | `LAUNCHPAD_ADDRESS`, `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` and `FILEBASE_BUCKET` set. `FILEBASE_GATEWAY_URL` is optional and falls back to `https://ipfs.filebase.io` | 503 `not-live` |
| 4 | `isAllowedLauncher(wallet)` on the launchpad through one module-level chain client, created once with `createChainClient()`, the paced server client, and reused across requests | 403 `not-allowed`; an RPC failure is 503 `gate-unavailable`, never a pass |
| 5 | `content-type` is multipart and the body, read from the stream with a running count, stays at or under 2,200,000 bytes, room for the 2,097,152-byte image plus the text fields; it is then parsed with `new Response(bytes, { headers }).formData()` | 413 `too-large`, 400 `bad-form` |
| 6 | Field rules above | 400 `bad-field` with the field name in `error` |
| 7 | Image at most 2,097,152 bytes and its first bytes are PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a` or `GIF89a`, or WebP `RIFF` then `WEBP` at offset 8. SVG and everything else refused | 413 `too-large`, 415 `bad-image` |
| 8 | `sharp(bytes).metadata()` reports a `format` of `png`, `jpeg`, `gif` or `webp`, agreeing with the sniffed type | 415 `bad-image` |
| 9 | `sharp(bytes, { pages: 1, limitInputPixels: 50_000_000 }).rotate().resize(512, 512, { fit: "cover", position: "centre" }).webp({ quality: 82 }).toBuffer()`. One frame, so an animated GIF becomes still; EXIF and any appended data are gone | 422 `unreadable-image` |
| 10 | Persistent budget, a quick unlocked read: this wallet's rows with status `pending`, `used` or `deleted` over the last 3,600 s and 86,400 s, refused at 5 and 20, so a wallet over its limit costs no pin. `refused` rows are not counted | 429 `upload-limit` |
| 11 | Filebase PUT of the WebP to `launch/img/<sha256 of the WebP>.webp`, read `x-amz-meta-cid`; build the metadata JSON; PUT it to `launch/meta/<sha256 of the JSON>.json`, read its CID. 15 s timeout each. No database transaction is open during these calls | 502 `storage-failed` when a PUT fails or the header is missing |
| 12 | One short transaction: `select pg_advisory_xact_lock(hashtext($wallet))`, recount as in step 10, insert the `launch_uploads` row with status `pending`, commit. The lock makes two parallel uploads from one wallet count each other | 429 `upload-limit` when the recount refuses; the row is then inserted with status `refused` in the same transaction (amended 29 Sep 2026), so the nightly clean-up can remove its objects; it is not counted against the budget. 503 through `failure()` on a database error. The pinned objects are never deleted on either path (amended 29 Sep 2026): the same content-hash key may already back another upload or a live launch, so a delete here could remove someone else's image. An object left without a row is harmless and is overwritten by the next identical upload |

The limits count rows other than `refused`, and a row is inserted only after both pins succeed, so the limits count
successful uploads, not attempts; refused and failed requests cost only the in-process budget of step 2.

**Metadata JSON**, Doppler and LONG compatible, keys in this order, no whitespace, empty strings kept:

```json
{"name":"...","symbol":"...","description":"...","image":"ipfs://<imageCid>","website":"...","x":"...","telegram":"..."}
```

Filebase is called at `https://s3.filebase.com/<FILEBASE_BUCKET>/<key>`, region `us-east-1`, service `s3`, with the
bucket's server-side keys only. Keys by content hash make a repeated upload of the same bytes a harmless overwrite
with the same CID.

**Orphans.** The nightly job, `src/lib/sync/nightly.ts:23`, gains a phase `"uploads"` between `"holders"` and
`"probe"`. The cut-off is measured against how far the reader has got, not the wall clock (amended 29 Sep 2026): a
launch the reader has not folded yet has not marked its upload used, and deleting that upload would blank a live
token. So:

1. The phase is skipped when the chain job's `last_ok_at` is more than one hour old, since the reader is stalled and
   its cursor says nothing about recent launches.
2. `cutoff = timestamp of the chain cursor's block − 86400 − 1200`, the block timestamp read with one RPC call; 1,200
   s is the form's permit and launch deadline, the longest a signed launch can wait before it lands.
3. It takes up to 200 rows with `status in ('pending', 'refused') and created_at < cutoff`, oldest first (amended 29
   Sep 2026: refused rows are cleaned the same way). For each it deletes the metadata object unless another row with
   the same `metadata_cid` is `used`, or is `pending` or `refused` with `created_at >= cutoff`, deletes the image object
   under the same rule on `image_cid`, then sets `status = 'deleted'`. S3 `DeleteObject` unpins the CID. A failed
   delete leaves the row as it was for the next night.

The phase is skipped when `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` or `FILEBASE_BUCKET` is unset;
`FILEBASE_GATEWAY_URL` is not needed here and falls back as elsewhere. Health reports the count of `deleted` uploads
next to `launches.missingUploads` (5.2).

**Moderation.** Kobe sets `hidden = true` on a `market.launches` row with SQL. The page then shows no image,
description or links and the logo route answers "no logo" within the hour. The on-chain URI stays.

**Environment variable names**, never values: `NEXT_PUBLIC_LAUNCHPAD_ADDRESS`, `FILEBASE_ACCESS_KEY`,
`FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET`, `FILEBASE_GATEWAY_URL`. The last four are server-only; the first three
Filebase names are required, the gateway is optional with the fallback `https://ipfs.filebase.io`. `.env.example`
gains the five names with placeholders and one comment line each.

## 7. Screens

All screens sit behind the existing Suits gate (D44), which matches the launcher gate. They use the recipes in
`ui-api.md`: the chalk primary button with its disabled and pending forms, the amount field, the segmented N-cell
group, the hairline panel, the centred card, key/value rows, `Badge`, `Avatar`, `Spinner` and the toasts.

### 7.1 Nav

`NAV` in `src/components/TopBar.tsx:10-14` gains `{ href: "/launch", label: "Launch" }` after Traders. Both the
desktop and the phone rows map over it, so nothing else changes.

### 7.2 `/launch`

`src/app/launch/page.tsx` is a server page exporting `metadata = { title: "Launch" }` that renders one client
component, `LaunchForm`, the pattern of `/traders`.

**Not live.** While `LAUNCHPAD_ADDRESS` is unset the page shows only the centred card: kicker "Launch", title
"Launching is not live yet", body "Token launches open here once the launchpad contract is deployed."

**Form.** A single column at phone width; from `twocol` the form on the left and a 360 px summary panel on the right,
as the token page lays out its trade panel.

| Field | Behaviour |
|---|---|
| Image | Required. A file picker with a 96 px preview; the browser checks type and the 2,097,152-byte limit before any upload |
| Name | Required, counter in bytes, 32 at most |
| Symbol | Required, 11 bytes at most, shown as typed |
| Description | Optional, 500 characters |
| Website, X, Telegram | Optional, with the route's rules |
| Currency | A single-select popover built on `QuotePicker`'s recipe: search, then USDG first and the rest by 24 h volume from `useQuotes()`. Each row says "USD" when it has a fresh USD price, "No USD price" when it does not |
| Opening valuation | Four presets in a segmented group plus Custom. Presets are the currency's minimum times 1, 2, 5 and 20, clamped to its maximum: with the DEFAULT $5,000 minimum, $5K, $10K, $25K and $100K. With a USD price, presets and the custom field are in USD and converted to raw units at the current price; without one, both are in the currency's own units. The field shows the minimum and maximum and refuses values outside them |
| Snapped preview | "Opens at $4,995 · $0.000004995 per token", from `predictToken` then `openingFor` read through wagmi, re-read 300 ms after the last change to name, symbol, currency or valuation |
| First buy | Optional gross amount in the currency, router fee included as on the Buy panel (amended 29 Sep 2026), balance shown, and a Max button: the smaller of the balance minus the creation fee and the cap price, `V' × (1/(1 − cap) − 1) / 0.99 / (1 − routerFeeBps / 10_000) × 0.999`, which at the 20 % cap and 50 bps is about 25.4 % of `V'`. Below it: "About N tokens, x % of supply" from `S × y / (V' + y)` with `y = 0.99 × (amount − floor(amount × routerFeeBps / 10_000))`. The form sends `minFirstBuyTokens` as that estimate less 0.5 %, and 0 without a first buy |
| Payout | Collapsed "Fee payout" row, default "Your wallet"; an address field when opened |

**Summary panel.** Opening valuation `V'`; opening price per token; first buy, with "of which router fee" at the live
`routerFeeBps` on the line below; creation fee reading "Free" at 0; "You pay" as first buy plus creation fee, or "Gas
only" when it is zero (amended 29 Sep 2026); the creator's fee share, "N % of trading fees to your payout address",
with N read live from `creatorShareBps()` and never hard-coded; launches left today from `launchesToday`, "The count resets at 00:00 UTC";
the rule of thumb from 3.4. No line says or implies that every buyer pays the same price.

**Button reasons**, first match wins: not connected, "Connect a wallet to launch."; `isAllowedLauncher` false,
"Launching is open to Suits holders."; limit reached, "You have used today's launches."; image, name or symbol
missing; valuation out of range; first buy above balance; first buy above the cap; otherwise "Launch".

**Submit steps**, shown as a numbered list under the button with a `Spinner` on the current step and a check on
finished ones:

1. **Sign in.** Only without a session: the existing `SignModal` through `AppState`'s gate, with a new `GateKind`
   `"launch"`. Amended 29 Sep 2026: the signature is asked as soon as the connect modal hands over a wallet
   (`GateKind` `"connect"`, nothing queued behind it), once the cookie probe has settled and the holders-only gate has
   admitted the wallet, and never on a deployment without `SESSION_SECRET`; so a creator normally reaches this form
   already signed in. This step stays as the fallback for a wallet that declined that prompt, whose 7-day session
   expired, whose Suits read failed at connect, or that arrived without the connect modal: an automatic reconnect, or
   an account switch inside the wallet.
2. **Upload.** `POST /api/launch/upload`. The answer is kept for this image and these fields, so a retry does not
   upload again; an answer older than 12 hours is refreshed, well inside the 24-hour orphan window.
3. **Approve.** Only when the total is above zero and the currency's Permit2 allowance is short: ERC-20 `approve(PERMIT2,
   maxUint256)`, as `src/lib/swap.ts` does.
4. **Sign the payment.** Only when the total is above zero: `permitTypedData` from `src/lib/swap/permit.ts` with the
   launchpad as spender, `randomNonce()`, deadline now plus 1,200 s.
   The permitted amount is exactly `firstBuy + creationFee`.
5. **Confirm in wallet.** `simulateContract` first (amended 29 Sep 2026), so a revert is caught and shown with its
   decoded name before the wallet opens; then `writeContract` `launch(params, permit, signature)` with the same
   deadline; a zero total sends a zeroed permit and empty signature.
6. **Launching.** Wait for the receipt, parse `Launched` from logs filtered to the launchpad address. When the
   transaction was mined but reverted, replay it with `eth_call` at that block, same sender, data and value, and decode
   the revert from the replay, since a receipt carries no reason.
7. **Redirect** to `/t/<token>?launched=<txHash>`.

Wallet writes live in `src/lib/launch.ts` and mirror `executeSwap`: viem clients from `useWalletClient` and
`usePublicClient`, `LaunchFailedError`, `LaunchRejectedError`, `LaunchUnconfirmedError`, and the pending, confirmed,
unconfirmed and failed toasts. Unlike `executeSwap` it simulates before sending, as step 5 says. Error mapping, from
the simulation or the replay:

| Revert | Message |
|---|---|
| wallet rejection | "Cancelled in wallet. Nothing was spent." |
| `PoolAlreadyInitialized` | "Someone opened this token's pool first. A new address is ready; press Launch again." The form draws a new salt |
| `DailyLimitReached` | "You have used today's launches." |
| `NotAllowedToLaunch` | "Launching is open to Suits holders." |
| `FirstBuyTooLarge` | "The first buy is above the cap. Lower it and try again." |
| `FirstBuyTooSmall` | "The first buy would get fewer tokens than shown. Review and try again." |
| `BadPayout` | "That payout address cannot receive fees. Choose another." |
| `PermitMismatch` | "The fees changed. Review and try again." |
| `Expired` | "The launch expired before it was sent. Try again." |
| anything else | "Launch failed. Nothing was spent except gas." |

The ABI is an `as const` array in `src/lib/launch/abi.ts`, transcribed from `ISVLaunchpad.sol` and pinned by a
selector test. It also carries v4's `PoolAlreadyInitialized()` and Permit2's `InvalidNonce()` and
`SignatureExpired(uint256)`, so reverts that bubble up from those contracts decode by name.

### 7.3 Token page

**Indexing wait.** When `usePair` finds nothing and the URL carries `launched`, `TokenView` shows "Your token is live
on chain. Its page fills in within about two minutes." with the transaction link, and `usePair` refetches every 5 s
for up to five minutes before falling back to today's "No token at…" text, still with the link. The server-rendered
facts layer shows its unknown-token state meanwhile.

**Chip.** `TokenHeader`, beside the origin `Badge` at line 59, a second `Badge` "LAUNCHED HERE" when `pair.launch`.
The origin badge itself already prints `SV`.

**Launch rows.** `InfoList` in `ActivityTabs.tsx` appends, when `pair.launch`: Creator, with an explorer link;
Payout, with a link; Opening valuation, in USD when the quote has a price, else in the quote; First buy, the gross
`firstBuyIn + routerFee` and the tokens received, or "None"; Launched, date, age and a transaction link; Fee share,
"N % payout · M % MaxLong" with N from `launch.creatorShareBps` and M = 100 − N, never hard-coded (amended 29 Sep
2026); then Website, X and Telegram as links when present. Hidden launches show none of the three links.

**Liquidity row fix.** `InfoList`'s Liquidity row divides by 2 (`pair.liquidity / 2 / quoteUsd`), a leftover from the
two-sided figure D43 replaced. Since `pair.liquidity` is now the quote side alone, the row becomes
`pair.liquidity / quoteUsd`, with a test. It is part of this work because a fresh launch's liquidity is shown on this
row from its first buy (added 29 Sep 2026).

**Fee panel.** `LaunchFeesPanel` under `TradePanel` in the right column of `TokenView`, a hairline panel:

- "Uncollected fees": token and quote amounts from `uncollectedFees(token)` through `useReadContract`, refreshed every
  30 s, each split into "To payout" and "To MaxLong" by the view's own numbers.
- "Collected so far" from `pair.launch.feesCollected`.
- **Owed to you**, only when `owed(connectedWallet, token)` or `owed(connectedWallet, quote)` is above zero: the amount
  and a **Claim** button per currency sending `claim(currency, to)`, with `to` shown in an address field that
  defaults to the connected wallet and can be edited, so a wallet the token refuses can claim to another address
  (amended 29 Sep 2026). This is where a share whose delivery failed is taken (4.6).
- **Collect fees**, for anyone, disabled with "Nothing to collect yet." when both amounts are zero, sending
  `collectFees(token)` with the usual toasts.
- **Change payout**, only when the connected wallet equals the current payout: an address field and a button sending
  `setPayout(token, address)`; the panel says the change is permanent for this wallet once it hands the payout on.

### 7.4 Markets table

`ORIGIN_OPTIONS` in `src/lib/markets.ts:36-45` gains `{ key: "SV", label: "SV" }`; `filterPairs` already compares
`p.origin`. The row badge prints `SV` with no label map. The API's `launchpad` scope includes SV (5.4).

## 8. Tests and acceptance

### 8.1 Contracts

Unit, `test/unit/SVLaunchpad.t.sol` with an abstract fixture and `.fuzz.t.sol`, no network: a `PoolManager` deployed
in the test with `new PoolManager(address(this))`, the real Permit2 etched as SVRouter's tests do, `MockERC20` quotes
at 6 and 18 decimals, `MockERC721` as the gate, v4-core's `PoolSwapTest` for trades after launch. A helper searches
salts until the predicted token sits on the wanted side of the quote, so every behaviour runs in both currency orders.
Names follow `test_<snake_case_sentence>`; every assertion carries a plain-English message.

- **Launch**: the pool's `slot0` equals `sqrtAt(openTick)` and its tick equals `openTick`; the position's liquidity
  equals `L`; the launchpad's token balance is zero; supply is `S` minus the dust; the event carries exact values;
  `openTick` is a multiple of 200 and `V' ≤ V`; free launch pulls nothing, which a call-count pin on Permit2 proves;
  paid launch moves exactly `firstBuy + creationFee` and the fee wallet receives `routerFee + creationFee`, with
  `routerFee = floor(firstBuy × routerFeeBps / 10_000)` and exactly `net` swapped.
- **First buy**: the creator's token balance rises by exactly `tokensOut` and the PoolManager's token balance does not
  rise by it; `FirstBuyTooLarge` just above the cap and success just below; `FirstBuyTooSmall` one unit above the real
  output and success at it; the 1 % LP fee shows in `uncollectedFees` straight after.
- **Payout refusal**: `address(this)` and `POOL_MANAGER` as payout revert `BadPayout` at launch and in `setPayout`;
  zero in `setPayout` reverts `ZeroAddress`.
- **Fee wallet refusal** (amended 29 Sep 2026): the constructor and `setFeeWallet` revert `ZeroAddress` for zero and
  `BadPayout` for the launchpad's own address and for `POOL_MANAGER`; the constructor case uses
  `vm.computeCreateAddress` to pass the launchpad's future address.
- **Fee delivery**: a quote mock that reverts transfers to the payout credits the payout's share to `owed` while the
  fee wallet is paid, and the reverse; a mock that returns `false` and one that returns no data behave as refused and
  as paid respectively; `claim` pays the balance once, then reverts `NothingOwed`; after a claim to the first
  recipient reverts because the token refuses it, `claim(currency, secondAddress)` pays the second address in full;
  `claim` to `address(0)`, the launchpad or the PoolManager reverts `BadPayout`.
- **Fee-on-transfer quote** (amended 29 Sep 2026):
  - a mock that taxes every transfer: a launch whose first buy or creation fee pulls it reverts `PermitMismatch` at
    the measured pull of step 7;
  - a mock that taxes only transfers into the PoolManager: the pull passes and the settle of step 11.5 comes up short,
    so the launch reverts `CurrencyNotSettled`;
  - a free launch in the taxing mock, no first buy and no creation fee, succeeds because it never moves the quote;
    later trades and a collection on that pool split the measured increase and emit it in `FeesCollected`.
- **Balance invariant**, in the unit suite and as a Foundry invariant with collections, failed deliveries and claims
  in random order, including the fee-on-transfer mock: per currency, the launchpad's balance equals the sum of `owed`.
- **Every revert** in 4.5 to 4.9, each at its step, with call counts proving nothing moved before it.
- **Gate**: holder allowed; non-holder refused; codeless gate, reverting gate, short reply and gas-burning gate all
  refused; zero gate allows anyone.
- **Daily limit**: the sixth launch on one UTC day reverts; the first after `vm.warp` to the next day succeeds; limit
  0 blocks everyone.
- **Fees**: trades in both directions, then `uncollectedFees` equals what `collectFees` pays to the unit; 70/30
  split with the dust to the fee wallet; `NothingToCollect`; a second collection pays only new fees.
- **Payout**: only the current payout can move it; the creator cannot after handing it on; fees follow.
- **Admin**: every bound in 4.3, every setter event, constructor events, `Ownable2Step` transfer, renounce reverts,
  `setHook` accepts zero and a mined valid address and refuses a flagless one and each refused flag.
- **Callback**: a direct `unlockCallback` from a stranger reverts `NotPoolManager`; `vm.prank(POOL_MANAGER)` calling
  `unlockCallback` directly, with no launch in flight, reverts `UnexpectedCallback` (amended 29 Sep 2026; the same
  state a callback triggered by someone else's unlock would see).
- **`predictToken`** equals the deployed address.

Fuzz: valuation across `[MIN_VALUATION, MAX_VALUATION]` in both orders, asserting `V' ≤ V` exactly, `V' × 1.0202004 ≥ V` (amended 29 Sep 2026: one spacing step is 1.0001^200 = 1.0202003, so 1.0202 was a hair too tight),
owed at most `S`, `S − owed` within the dust bound of 3.3, `L` under the per-tick cap; first-buy amounts, asserting
tokens out match `S × y / (V' + y)` to a relative 1e-9, computed in the test with `FullMath` (amended 29 Sep 2026); fee
split sums. Invariant: after launch, no sequence of calls changes the position's liquidity.

Coverage: 100 % of lines, statements, branches and functions on `src/` from the unit suite alone, as for SVRouter.
The design has no unreachable branch on purpose: a partial first buy and a non-zero quote delta after the mint are left
to the PoolManager's `CurrencyNotSettled` rather than checked in code.

Fork, `test/fork/SVLaunchpadFork.t.sol`, skipped without `ROBINHOOD_RPC_URL`, block pinned and logged: deploy the
launchpad against the real PoolManager and Permit2; launch in USDG with no first buy and in NVDA with one, the NVDA
funded with `deal`; the `Initialize` log's pool id matches; buy and sell the new pool through the deployed SVRouter
and the Universal Router, with the V4 Quoter agreeing to the unit; `uncollectedFees` equals StateView's fee growth
maths and the actual collection; log the PoolManager's `protocolFeeController()` and the pool's `protocolFee`.

### 8.2 Frontend

Vitest, every SQL path on PGlite through `testDb()`:

- Migration applies in order.
- `decodeLog`: the three launchpad events built with viem's encoders, routed by address; a PoolManager topic0 from the
  launchpad address and a launchpad topic0 from any other address both drop.
- `hypersyncSource`: body without and with the launchpad; `address` selected; a log without an address dropped.
- Fold: `Initialize` then `Launched` in one batch labels pool and token SV; a later second pool with more quote money
  becomes primary while the token stays SV; one fee row per `FeesCollected`; the last payout per token wins;
  `loadFoldState` and `newTokenCandidates` accept a batch of only fee and payout events without reading a pool id.
- Health: `lastCycleFrom` parses a `last_report` without `launchEvents` as 0.
- Store: launch inserted once; uploads attached and marked used, a `deleted` upload never attached or revived; fee
  events inserted once when the same result is applied twice; `pair(id)`'s `feesCollected` equals the sum of the event
  rows, reads all "0" before any collection, and does not change when a batch is re-applied; payout last-write by
  position; rollback on a throw.
- Listing, with the clock passed in: an SV pool with no swaps lists and sorts by `created_at` ahead of older swapped
  tokens; at 86,400 s it leaves the table on the next `applyFold`; one that traded stays; the launchpad scope returns
  it.
- `pair(id)` carries the `launch` block, including for a delisted launch; hidden blanks the five fields; a normal
  token has `launch: null`.
- Liquidity row: no division by 2.
- Upload route: each check in section 6 in order, with Filebase's `fetch` mocked, `sharp` running on small fixture
  images including an animated GIF, a PNG with a payload after its end and a file whose magic bytes disagree with
  its format, the gate through a mocked chain client, the persistent limits counted in PGlite, two parallel uploads
  at the limit of which only one is accepted and the other stored as `refused` and not counted, an image of exactly 2,097,152 bytes accepted and one byte more refused,
  and no Filebase delete on a failed insert.
- Nightly `"uploads"` phase: deletes only below the cursor-based cut-off, skips when the chain job is over an hour
  stale, cleans `refused` rows like stale `pending` ones, keeps an object another row still needs, leaves a failed delete pending.
- Logo resolver: the launch stage, hidden, a failed database read that answers no logo without trying DexScreener,
  and the one-hour cache header.
- Components: `LaunchForm` reasons, steps, simulated-revert and replayed-revert messages with `@/lib/launch` mocked,
  and the fee share read from the contract; `LaunchFeesPanel` for a payout, a stranger and a wallet with an owed
  balance; `TopBar` nav; the SV origin option; the "LAUNCHED HERE" chip; the indexing wait.

Gates per task: `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src`, `npm run build`. Contracts:
`forge fmt --check`, `forge build --sizes`, `forge test`, `forge coverage --report summary`.

### 8.3 Deploy script

`script/DeployLaunchpad.s.sol`, in the style of `script/Deploy.s.sol`:

- env: `OWNER`, `FEE_WALLET`, `LAUNCHER_GATE`, read with `vm.envAddress`; `ROBINHOOD_RPC_URL` through `--rpc-url
  robinhood`; the deployer key through `--account`, `--ledger` or `--interactive`, never the environment;
- refuses any chain but 4663; refuses a PoolManager or Permit2 other than the constants in section 2 unless
  `ALLOW_OTHER_ADDRESSES=true`; requires code at both, and at `LAUNCHER_GATE` when it is not zero;
- reads `script/config/launch-currencies.json`. `foundry.toml` gains exactly one read-only permission,
  `fs_permissions = [{ access = "read", path = "./script/config" }]`;
- per row, a price as an integer `answer` with `feedDecimals` decimals: for the 24 feed currencies,
  `latestRoundData` on the row's Chainlink proxy, refusing to run unless `answer > 0` and `updatedAt` is within the
  last 3 days, the app's own staleness window; for USDG, `answer = 1` with `feedDecimals = 0`; for the other 29, the
  row's `referenceUsdPrice` as an 8-decimal integer, refusing to run while any is zero. Then, in integers, rounded
  down (amended 29 Sep 2026):
  `min = minUsd × 10^quoteDecimals × 10^feedDecimals / answer` and
  `max = maxUsd × 10^quoteDecimals × 10^feedDecimals / answer`, checked against `MIN_VALUATION` and `MAX_VALUATION`;
- ownership sequence (amended 29 Sep 2026): the broadcaster deploys with itself as owner, calls `setCurrency` for
  every row with the file's `creationFee`, 0 today, then `transferOwnership(OWNER)`. `Ownable2Step` leaves `OWNER` as
  pending owner until it calls `acceptOwnership`, which is Kobe's step 4 in section 9. When `OWNER` is the
  broadcaster itself, the transfer is skipped;
- prints every row's raw bounds and their USD value, then the settings read back.

The config file is generated once by a frontend script, `scripts/launch/currency-config.mts`, from `quotes.json`, so
the allowlist is always a subset of the currencies the reader recognises, with `referenceUsdPrice` blank for Kobe to
fill in the 29 rows without a feed. Top level: `minUsd: 5000`, `maxUsd: 10000000`, `creationFee: 0`.

## 9. Rollout, done by Kobe

1. Fill the 29 reference prices in `script/config/launch-currencies.json` and commit it.
2. Dry run against a local anvil fork of 4663; read the printed bounds.
3. Deploy with `--broadcast`: owner and fee wallet Kobe's EOA as for SVRouter, `LAUNCHER_GATE` the Suits NFT. Verify
   through Sourcify as for SVRouter. Record the address and block in both READMEs.
4. From `OWNER`, call `acceptOwnership` if the deployer was a different key. Read the settings back: owner `OWNER`,
   router fee 50, creator share 7,000, first-buy cap 2,000, daily limit 5, hook zero, gate the Suits NFT, 54
   currencies.
5. `npm run db:migrate` against production before pushing the frontend: the store's queries need the tables.
6. On Vercel set `NEXT_PUBLIC_LAUNCHPAD_ADDRESS`, `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET`,
   `FILEBASE_GATEWAY_URL`, then push. Set the address before anyone launches: a launch the reader has already passed
   over needs a catch-up rewind to appear.
7. Rehearsal: one free USDG launch and one NVDA launch with a small first buy; check the table row, the SV badge, the
   chip, a buy and a sell through the site, a fee collection and the split; hide the rehearsal tokens.
8. Ownership and fee wallet to MAXLONG's Safe at handover, `Ownable2Step`.

## 10. Costs

| Item | Value |
|---|---|
| Extra HyperSync requests | 0; the launchpad rides the minute request |
| Extra crons | 0; the clean-up is a nightly phase |
| New tables | 3, small; `launch_fee_events` grows by one row per collection |
| Extra reads | one indexed sum over `launch_fee_events` per single-token request, inside the existing 30-second memo |
| Filebase | Pro plan Kobe already pays, $7.50 a month; about 100 KB per launch after re-encoding |
| Gas per launch | one token deployment, one pool initialisation, one mint, optionally one swap: cents |
| Gas to deploy | a few dollars, plus 54 `setCurrency` calls |

## 11. Out of scope

Anti-snipe hooks; dynamic fees; creator tokens or vesting; a raise; a list page; a progress bar; a countdown; image
or metadata changes after launch; animated images; an admin screen for `hidden`; the launchpad on the traders board;
more than one pool per launch; a Suits fee discount.

## 12. Risks and open items

| Item | Who decides |
|---|---|
| DEFAULT valuation bounds: USD 5,000 minimum, USD 10,000,000 maximum per currency, converted at deploy; the 29 currencies without a USD price use reference prices Kobe supplies | Kobe and MAXLONG |
| DEFAULT presets: the minimum times 1, 2, 5 and 20 | Kobe |
| DEFAULT listing window: an SV pool with no trades is listed for its first 24 hours only, then leaves the table until someone buys, so five launches per wallet per day cannot flood the 500 rows (5.4, ruling of 29 Sep 2026) | Kobe |
| No audit. Between a failed fee delivery and its claim the launchpad holds that share in `owed` (4.6); nothing else stays in it | MAXLONG |
| Issuing is not listing: MAXLONG becomes the party whose contract creates tokens. Its counsel should see this before public launches | MAXLONG |
| The risk without an audit is a bug in the launch or collection path; the locked positions cannot be withdrawn by any code | MAXLONG |
| Front-run griefing, 4.10: accepted | Kobe, settled |
| Filebase's acceptable-use policy can remove content or suspend the account; takedowns go through `hidden` and abuse@filebase.com | Kobe |
| A hidden launch keeps its on-chain URI; other sites can still show the image | Kobe |
| The deployed PoolManager's storage layout must match v4.0.0 for `uncollectedFees`; the fork suite is the proof | Kobe, at the fork run |
| The PoolManager's protocol fee is unknown until read on the fork; any protocol fee reduces what the position earns | Kobe, at the fork run |
| A future anti-snipe hook that needs a dynamic fee needs a new launchpad, 4.9 | Kobe and MAXLONG, when wanted |
| A currency added later by `setCurrency` but missing from `quotes.json` would launch a pool the reader ignores; add it to `quotes.json` first | Kobe |
| The launchpad's size may force the 200-run build profile, 4.11 | the plan's first task |
| Found while verifying: the token page's Liquidity row still divided by 2; fixed as part of this work, 7.3 (amended 29 Sep 2026) | settled |

## 13. Health

`sync.lastCycle.launchEvents` counts the launchpad events folded in the last cycle, 0 when an older report lacks it.
`launches.missingUploads` counts launches whose upload was not found, and `launches.deletedUploads` the uploads the
nightly clean-up removed (5.2, section 6). `launches.storage` (added 29 Sep 2026) is the Filebase bucket check: a HEAD
on the configured bucket with the configured keys, reported as `ok`, Filebase's own answer (`answered 403` is a wrong
key or secret, `answered 404` a wrong bucket name), `no answer`, or `unset`, with the bucket name and the two key
lengths beside it so a value pasted with a stray character shows as a length one off. No value leaves the server.

## 14. Engineering details this spec settled

Each is a choice the brief left open; each can be changed at review.

1. Snapping rounds the valuation down in both currency orders, so the pool never opens above what the creator asked;
   the bounds check applies to the requested value, so `V'` can sit up to about 2 % under a currency's minimum.
2. Validity is guaranteed by two constants, `MIN_VALUATION = 1e8` and `MAX_VALUATION = 1e36` (amended 29 Sep 2026: the first buy's `int128` limit, 3.3), enforced by
   `setCurrency`, instead of simulating each bound.
3. The router fee on the first buy is taken out of it exactly as SVRouter does (ruling of 29 Sep 2026): `routerFee =
   floor(firstBuy × routerFeeBps / 10,000)`, `net = firstBuy − routerFee` is swapped, the Permit2 total is `firstBuy +
   creationFee`, and the event records both `net` and `routerFee` so the page can show the gross.
4. First-buy tokens go to the creator, the wallet that called `launch` and paid, carried in the callback payload
   because inside the callback `msg.sender` is the PoolManager. `minFirstBuyTokens` guards what it receives.
5. Unplaced token dust is burned in the launch transaction.
6. `collectFees` reverts `NothingToCollect` when both amounts are zero, so the reader never sees empty events.
7. `dailyLaunchLimit = 0` is the launchpad's pause.
8. The `Launched` payload is one tuple, `LaunchedData`, because sixteen loose values would exceed the legacy code
   generator's stack.
9. `FeesCollected` reports token and quote amounts, not currency0 and currency1, and only the payout part; the fee
   wallet's part is the difference. The amounts are the measured balance increases, so a fee-on-transfer quote is
   split on what arrived (amended 29 Sep 2026).
10. Launches are keyed by token address; there is no numeric id.
11. The CREATE2 salt mixes in the caller.
12. The launchpad's log selection filters to the three activity events; setting events are not indexed.
13. A token with any SV pool keeps origin SV even when another pool becomes primary.
14. Fee totals are never stored: they are summed on read from `market.launch_fee_events`, keyed by (transaction,
    log index), which the store only inserts into with on conflict do nothing (amended 29 Sep 2026); payout updates are made idempotent by the last applied (block, log index)
    stored on the launch row.
15. Links and the image CID reach `market.launches` from `market.launch_uploads` by metadata CID; a launch made
    without the upload route gets its logo from its metadata JSON and shows no links.
16. `launch_uploads` has one row per successful upload, inserted only after both pins, so the persistent limits count
    successful uploads; a per-wallet advisory lock makes parallel uploads count each other; the nightly clean-up never
    deletes an object another row still needs, measures its cut-off from the reader's cursor, and the upload route
    never deletes objects.
17. Launch logos are cached for one hour, not a week, so `hidden` takes effect within the hour.
18. The upload route checks the gate through the launchpad's own `isAllowedLauncher` view.
19. The form requires an image; the contract accepts an empty URI.
20. The form reads `predictToken` and `openingFor` from the contract instead of porting `TickMath` to TypeScript.
21. The indexing wait lives on the token page, keyed by a `launched` query parameter.
22. The deploy config lives in the contracts repo behind one read-only `fs_permissions` entry, and USD conversion
    for priced currencies reads Chainlink on chain during the deploy.
23. An expression index on `coalesce(last_swap_at, created_at)` backs the new table order.
24. Events, by ruling of 29 Sep 2026: three activity events for the reader plus one `<Thing>Changed` event per owner
    setting, emitted by each setter and once by the constructor; `claim` emits nothing.
25. Fee shares are taken into the launchpad inside the unlock and delivered after it, each by a tolerant low-level
    transfer; a refused delivery is credited to `owed` and taken later with `claim`, so no recipient, and no owner
    setting, can freeze another recipient's share (ruling of 29 Sep 2026). `claim` pays to an address the claimant
    names, so a recipient the token refuses can still take its share.
26. `address(this)` and the PoolManager are refused as payout, at launch and in `setPayout`.
27. An unswapped SV pool is listed for its first 24 hours only; a delisted launch keeps its token page through
    `pair(id)`'s fallback to the launch pool.
28. The form simulates the launch before sending and decodes a mined revert by replaying it with `eth_call`.
29. The quote-first sqrt price rounds up, so `V' ≤ V` holds exactly in both orders.
30. A failed launch-row read in the logo resolver answers no logo for that request instead of falling through.

## 15. Draft Decision Log entry

| D47 | Instant launchpad | Sep 29, 2026 (K). The launchpad is instant, and the presale design of Sep 27 is deferred until MAXLONG pays for an audit. One transaction, signed by a Suits holder, deploys a token of one billion supply with no owner, opens its Uniswap v4 pool at the valuation the creator picks, and places the whole supply in one position from that price to the top of the range, owned by the launchpad contract, which has no way to withdraw it. The creator needs gas only and receives no free tokens; they may buy first at the opening price with their own money, up to 20 % of the supply, and the 0.5 % fee comes out of that buy exactly as it does on every trade. The pool fee is 1 %; collected trading fees go 70 % to the launch's payout address and 30 % to MAXLONG, and anyone may trigger a collection. If either side cannot receive its share, that share waits in the contract for its owner to claim, so neither side can hold up the other. Any of the 54 quote assets can be used, with opening valuations between USD 5,000 and 10,000,000 set per asset at deploy, pending MAXLONG's confirmation. Each wallet may launch five times a day. Token images are re-encoded and pinned on Filebase before the launch. Launched tokens carry the SV badge and list from their launch block; one nobody has bought leaves the markets table after 24 hours and returns with its first trade, pending Kobe's confirmation, and its token page stays up. Spec: frontend `docs/superpowers/specs/2026-09-28-instant-launchpad-design.md`. | K |
