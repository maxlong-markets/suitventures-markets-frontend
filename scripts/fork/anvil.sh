#!/usr/bin/env bash
# Starts an anvil fork of Robinhood Chain for the M2 swap end-to-end run and prints the
# funded test accounts. Leave it running; the other two fork scripts talk to it.
#
#   FORK_RPC_URL   what to fork (default: the public Robinhood Chain endpoint)
#   FORK_PORT      anvil's port (default: 8545)
#   FORK_BLOCK     pin a block; unset means the chain head
#
# The public endpoint keeps only about the last 50,000 blocks of state (roughly 80 minutes
# at this chain's ~0.1 s blocks), so a pinned block older than that will not serve.
set -euo pipefail

export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

RPC_URL="${FORK_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${FORK_PORT:-8545}"

if ! command -v anvil >/dev/null 2>&1; then
  echo "anvil not found. Install Foundry: https://getfoundry.sh" >&2
  exit 1
fi

cat <<EOF
anvil fork of Robinhood Chain (chain id 4663) on port ${PORT}, forking ${RPC_URL}

Funded test accounts. These are anvil's own published keys: public knowledge, worthless
anywhere but this local fork, and the only keys this harness ever uses.

  #0  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
      0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  #1  0x70997970C51812dc3A010C7d01b50e0d17dc79C8
      0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  #2  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
      0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

In another shell, from the repo root:
  npm run fork:deploy   # deploys SVRouter onto this fork and writes .env.fork
  npm run fork:e2e      # a real buy and a real sell through the app's own code

EOF

# Not an array of extra args: macOS ships bash 3.2, where "${arr[@]}" on an empty array is
# itself an unbound reference under `set -u` and aborts the script before anvil ever starts.
# An if/else avoids it.
if [ -n "${FORK_BLOCK:-}" ]; then
  exec anvil --fork-url "$RPC_URL" --chain-id 4663 --port "$PORT" --fork-block-number "$FORK_BLOCK"
else
  exec anvil --fork-url "$RPC_URL" --chain-id 4663 --port "$PORT"
fi
