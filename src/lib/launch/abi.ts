import { LAUNCHPAD_EVENTS_ABI } from "@/lib/chain/abi";

/**
 * `ISVLaunchpad` (instant launchpad design, section 4.2), hand-transcribed in the interface's order: the anyone functions,
 * the owner setters, the views, the activity events (shared with the reader through `LAUNCHPAD_EVENTS_ABI`), the setting
 * events and every custom error. Three foreign errors ride along so a revert that bubbles up from another contract
 * during a launch reads by name (spec 7.2): v4's `PoolAlreadyInitialized()`, Permit2's `InvalidNonce()` and
 * `SignatureExpired(uint256)`. `abi.test.ts` pins every selector and topic0 against the spec's canonical signatures, so a
 * fragment that drifts from the contract fails the suite here instead of a transaction.
 */

const LAUNCH_PARAMS = [
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "metadataUri", type: "string" },
  { name: "quote", type: "address" },
  { name: "valuation", type: "uint256" },
  { name: "firstBuy", type: "uint256" },
  { name: "minFirstBuyTokens", type: "uint256" },
  { name: "payout", type: "address" },
  { name: "salt", type: "bytes32" },
  { name: "deadline", type: "uint256" },
] as const;

const PERMIT_TRANSFER_FROM = [
  {
    name: "permitted",
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const LAUNCH = [
  { name: "creator", type: "address" },
  { name: "launchedAt", type: "uint64" },
  { name: "creatorShareBps", type: "uint16" },
  { name: "tokenIsCurrency0", type: "bool" },
  { name: "payout", type: "address" },
  { name: "openTick", type: "int24" },
  { name: "quote", type: "address" },
  { name: "hook", type: "address" },
  { name: "liquidity", type: "uint128" },
] as const;

const POOL_KEY = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const PENDING_FEES = [
  { name: "tokenFees", type: "uint256" },
  { name: "quoteFees", type: "uint256" },
  { name: "tokenToPayout", type: "uint256" },
  { name: "quoteToPayout", type: "uint256" },
  { name: "tokenToFeeWallet", type: "uint256" },
  { name: "quoteToFeeWallet", type: "uint256" },
] as const;

const CURRENCY_CONFIG = [
  { name: "minValuation", type: "uint256" },
  { name: "maxValuation", type: "uint256" },
  { name: "creationFee", type: "uint256" },
] as const;

export const svLaunchpadAbi = [
  // ---- anyone -------------------------------------------------------------------------------------------------
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "p", type: "tuple", components: LAUNCH_PARAMS },
      { name: "permit", type: "tuple", components: PERMIT_TRANSFER_FROM },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  { type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "currency", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPayout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "payout", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "unlockCallback",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes" }],
  },
  // ---- owner only ---------------------------------------------------------------------------------------------
  { type: "function", name: "setFeeWallet", stateMutability: "nonpayable", inputs: [{ name: "wallet", type: "address" }], outputs: [] },
  { type: "function", name: "setRouterFee", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setCreatorShare", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setFirstBuyCap", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint16" }], outputs: [] },
  { type: "function", name: "setDailyLaunchLimit", stateMutability: "nonpayable", inputs: [{ name: "limit", type: "uint8" }], outputs: [] },
  { type: "function", name: "setLauncherGate", stateMutability: "nonpayable", inputs: [{ name: "gate", type: "address" }], outputs: [] },
  { type: "function", name: "setHook", stateMutability: "nonpayable", inputs: [{ name: "hook", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "setCurrency",
    stateMutability: "nonpayable",
    inputs: [
      { name: "quote", type: "address" },
      { name: "minValuation", type: "uint256" },
      { name: "maxValuation", type: "uint256" },
      { name: "creationFee", type: "uint256" },
    ],
    outputs: [],
  },
  // ---- views --------------------------------------------------------------------------------------------------
  {
    type: "function",
    name: "getLaunch",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: LAUNCH }],
  },
  {
    type: "function",
    name: "poolKeyOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: POOL_KEY }],
  },
  {
    type: "function",
    name: "uncollectedFees",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: PENDING_FEES }],
  },
  {
    type: "function",
    name: "predictToken",
    stateMutability: "view",
    inputs: [
      { name: "creator", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "openingFor",
    stateMutability: "pure",
    inputs: [
      { name: "token", type: "address" },
      { name: "quote", type: "address" },
      { name: "valuation", type: "uint256" },
    ],
    outputs: [
      { name: "openTick", type: "int24" },
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "snappedValuation", type: "uint256" },
    ],
  },
  { type: "function", name: "isAllowedLauncher", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "launchesToday", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "currency",
    stateMutability: "view",
    inputs: [{ name: "quote", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: CURRENCY_CONFIG }],
  },
  {
    type: "function",
    name: "owed",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "launchCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "feeWallet", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "routerFeeBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "creatorShareBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "firstBuyCapBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "dailyLaunchLimit", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "launcherGate", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "hook", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "POOL_MANAGER", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  // ---- events -------------------------------------------------------------------------------------------------
  ...LAUNCHPAD_EVENTS_ABI,
  { type: "event", name: "FeeWalletChanged", inputs: [{ name: "wallet", type: "address", indexed: true }] },
  { type: "event", name: "RouterFeeChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "CreatorShareChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "FirstBuyCapChanged", inputs: [{ name: "bps", type: "uint16", indexed: false }] },
  { type: "event", name: "DailyLaunchLimitChanged", inputs: [{ name: "limit", type: "uint8", indexed: false }] },
  { type: "event", name: "LauncherGateChanged", inputs: [{ name: "gate", type: "address", indexed: true }] },
  { type: "event", name: "HookChanged", inputs: [{ name: "hook", type: "address", indexed: true }] },
  {
    type: "event",
    name: "CurrencyChanged",
    inputs: [
      { name: "quote", type: "address", indexed: true },
      { name: "minValuation", type: "uint256", indexed: false },
      { name: "maxValuation", type: "uint256", indexed: false },
      { name: "creationFee", type: "uint256", indexed: false },
    ],
  },
  // ---- errors -------------------------------------------------------------------------------------------------
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "RenounceDisabled", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "NotAllowedToLaunch", inputs: [] },
  { type: "error", name: "DailyLimitReached", inputs: [] },
  { type: "error", name: "BadName", inputs: [] },
  { type: "error", name: "BadSymbol", inputs: [] },
  { type: "error", name: "UriTooLong", inputs: [] },
  { type: "error", name: "CurrencyNotAllowed", inputs: [] },
  {
    type: "error",
    name: "ValuationOutOfRange",
    inputs: [
      { name: "valuation", type: "uint256" },
      { name: "min", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
  },
  { type: "error", name: "PermitMismatch", inputs: [] },
  {
    type: "error",
    name: "FirstBuyTooLarge",
    inputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "FirstBuyTooSmall",
    inputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "min", type: "uint256" },
    ],
  },
  { type: "error", name: "BadPayout", inputs: [] },
  { type: "error", name: "FeeTooHigh", inputs: [] },
  { type: "error", name: "BpsTooHigh", inputs: [] },
  { type: "error", name: "BoundsOutOfRange", inputs: [] },
  { type: "error", name: "HookNotAllowed", inputs: [] },
  { type: "error", name: "UnknownLaunch", inputs: [] },
  { type: "error", name: "NotPayout", inputs: [] },
  { type: "error", name: "NothingToCollect", inputs: [] },
  { type: "error", name: "NothingOwed", inputs: [] },
  { type: "error", name: "NotPoolManager", inputs: [] },
  { type: "error", name: "UnexpectedCallback", inputs: [] },
  // Foreign errors a launch can bubble up (spec 7.2): v4's PoolManager, then Permit2.
  { type: "error", name: "PoolAlreadyInitialized", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [{ name: "signatureDeadline", type: "uint256" }] },
] as const;
