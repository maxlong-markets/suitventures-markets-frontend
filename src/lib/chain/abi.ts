import { parseAbi, toEventSelector } from "viem";

/**
 * The Uniswap v4 PoolManager on Robinhood Chain (chain 4663), and the three events this reader
 * decodes from it. Signatures are copied verbatim from the indexer's `config.yaml` (source of
 * truth for what is actually deployed); `abi.test.ts` pins every topic0 against the Solidity
 * signature, so a mistyped field fails the suite rather than silently decoding garbage.
 *
 * Addresses are lowercased at the boundary and compared lowercase everywhere (types.ts's
 * convention), so POOL_MANAGER is written lowercase here rather than checksummed.
 */
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

const INITIALIZE_SIGNATURE =
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)";
const SWAP_SIGNATURE =
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)";
const MODIFY_LIQUIDITY_SIGNATURE =
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)";

/** The three PoolManager events this reader tracks, and nothing else (no Transfer, no Chainlink). */
export const POOL_MANAGER_EVENTS_ABI = parseAbi([INITIALIZE_SIGNATURE, SWAP_SIGNATURE, MODIFY_LIQUIDITY_SIGNATURE]);

/** topic0 of each event: HyperSync's log filter (hypersyncSource.ts) and decode.ts's dispatch both key off these. */
export const TOPIC0 = {
  initialize: toEventSelector(INITIALIZE_SIGNATURE),
  swap: toEventSelector(SWAP_SIGNATURE),
  modifyLiquidity: toEventSelector(MODIFY_LIQUIDITY_SIGNATURE),
} as const;

/**
 * The instant launchpad's three activity events (instant launchpad design, section 4.2), transcribed from
 * `ISVLaunchpad.sol`. The reader decodes these and nothing else from the launchpad: its setting events are left out of
 * the HyperSync filter. `src/lib/launch/abi.ts` spreads this array into the whole interface, so the reader and the
 * wallet code can never disagree; `src/lib/launch/abi.test.ts` pins every topic0. `Launched` carries one tuple,
 * `LaunchedData`, because sixteen loose values would not fit the contract's legacy code generator (spec 14.8).
 */
export const LAUNCHPAD_EVENTS_ABI = [
  {
    type: "event",
    name: "Launched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "quote", type: "address", indexed: true },
      {
        name: "data",
        type: "tuple",
        indexed: false,
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "payout", type: "address" },
          { name: "hook", type: "address" },
          { name: "tokenIsCurrency0", type: "bool" },
          { name: "openTick", type: "int24" },
          { name: "openingValuation", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "tokensInPool", type: "uint256" },
          { name: "firstBuyIn", type: "uint256" },
          { name: "firstBuyTokens", type: "uint256" },
          { name: "routerFee", type: "uint256" },
          { name: "creationFee", type: "uint256" },
          { name: "creatorShareBps", type: "uint16" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataUri", type: "string" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "FeesCollected",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "payout", type: "address", indexed: true },
      { name: "tokenFees", type: "uint256", indexed: false },
      { name: "quoteFees", type: "uint256", indexed: false },
      { name: "tokenToPayout", type: "uint256", indexed: false },
      { name: "quoteToPayout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PayoutChanged",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "previous", type: "address", indexed: true },
      { name: "payout", type: "address", indexed: true },
    ],
  },
] as const;

/** topic0 of each launchpad activity event: the source's second log selection and decode.ts's dispatch key off these. */
export const LAUNCH_TOPIC0 = {
  launched: toEventSelector(LAUNCHPAD_EVENTS_ABI[0]),
  feesCollected: toEventSelector(LAUNCHPAD_EVENTS_ABI[1]),
  payoutChanged: toEventSelector(LAUNCHPAD_EVENTS_ABI[2]),
} as const;
