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
