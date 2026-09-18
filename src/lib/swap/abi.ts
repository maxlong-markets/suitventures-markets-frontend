/**
 * The pieces of the on-chain interfaces this app touches, transcribed from
 * `SuitVenturesMarket-contracts/src/interfaces/ISVRouter.sol` and `src/SVRouter.sol`. `abi.test.ts`
 * pins every selector against the Solidity signature, so a mistyped field fails the suite rather
 * than a transaction.
 *
 * `PoolKey` is v4-core's struct: `Currency` and `IHooks` are user-defined value types over
 * `address`, so they are plain addresses in the ABI; `fee` is `uint24` and `tickSpacing` `int24`.
 * `ISignatureTransfer.PermitTransferFrom` carries no `spender` — the router is the spender because
 * it is the caller; the EIP-712 message signed off-chain does name it (see `permit.ts`).
 */
export const svRouterAbi = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          {
            name: "key",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMin", type: "uint128" },
          { name: "hookData", type: "bytes" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "permit",
        type: "tuple",
        components: [
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
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "event",
    name: "Trade",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "holderRate", type: "bool", indexed: false },
    ],
  },
  // The router's own reverts.
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "PermitMismatch", inputs: [] },
  { type: "error", name: "FeeTooHigh", inputs: [] },
  { type: "error", name: "RenounceDisabled", inputs: [] },
  {
    type: "error",
    name: "InsufficientOutput",
    inputs: [
      { name: "received", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  // Raised through the router by the Universal Router and by v4; here so a revert can be read, never
  // to be called. ExecutionFailed wraps the inner revert's calldata in `message`.
  {
    type: "error",
    name: "ExecutionFailed",
    inputs: [
      { name: "commandIndex", type: "uint256" },
      { name: "message", type: "bytes" },
    ],
  },
  { type: "error", name: "TransactionDeadlinePassed", inputs: [] },
  {
    type: "error",
    name: "V4TooLittleReceived",
    inputs: [
      { name: "minAmountOutReceived", type: "uint256" },
      { name: "amountReceived", type: "uint256" },
    ],
  },
] as const;

/**
 * The three functions the swap reads and writes, and nothing else. `decimals()` is deliberately
 * absent: the balances hook reads it through viem's own `erc20Abi`, and a second fragment for the
 * same function would only be kept alive by this file's test.
 */
export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Permit2 is signed, not called, by this app: the only readable thing worth having is the nonce
 * bitmap, for diagnosing a replayed nonce from a script.
 */
export const permit2Abi = [
  {
    type: "function",
    name: "nonceBitmap",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "wordPos", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
