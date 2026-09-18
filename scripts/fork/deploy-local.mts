/**
 * Deploys SVRouter onto the running anvil fork with the contracts repo's own deploy script,
 * prints the router address and writes .env.fork for the e2e run.
 *
 * Run: npm run fork:deploy   (with npm run fork:anvil running in another shell)
 *
 *   FORK_RPC_URL    the anvil endpoint (default http://127.0.0.1:8545)
 *   CONTRACTS_DIR   the contracts repo (default ../SuitVenturesMarket-contracts)
 *
 * script/Deploy.s.sol takes OWNER, FEE_WALLET, UNIVERSAL_ROUTER and PERMIT2 from the
 * environment, refuses any chain but 4663, and refuses any router or Permit2 but the spec's
 * constants unless ALLOW_OTHER_ADDRESSES is set — which this script never sets, because a
 * fork of Robinhood Chain has the real ones deployed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { PERMIT2_ADDRESS, UNIVERSAL_ROUTER_ADDRESS } from "@/lib/chain";

// The nightly banner would otherwise land in forge's inherited output and corrupt what a human
// reads there; every fork script that can shell out to Foundry sets this (verified 18 Sep 2026).
process.env.FOUNDRY_DISABLE_NIGHTLY_WARNING ??= "1";

/** anvil's published test account #0. Public knowledge, funded only on a local fork. */
const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

const rpcUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
const contractsDir = resolve(process.env.CONTRACTS_DIR ?? "../SuitVenturesMarket-contracts");

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!LOCAL_RPC.test(rpcUrl)) {
  die("FORK_RPC_URL must point at the local anvil fork; refusing to broadcast anywhere else.");
}
if (!existsSync(resolve(contractsDir, "script/Deploy.s.sol"))) {
  die(`No script/Deploy.s.sol under ${contractsDir}. Set CONTRACTS_DIR to the contracts repo.`);
}
// Same courtesy anvil.sh gives: a missing Foundry must say so, not raise ENOENT from execFileSync.
try {
  execFileSync("forge", ["--version"], { stdio: "ignore" });
} catch {
  die("forge not found. Install Foundry: https://getfoundry.sh");
}

const client = createPublicClient({ transport: http(rpcUrl) });
let chainId: number;
try {
  chainId = await client.getChainId();
} catch {
  die(`No node answering at ${rpcUrl}. Start it with: npm run fork:anvil`);
}
if (chainId !== 4663) {
  die(`The node at ${rpcUrl} reports chain id ${chainId}, not 4663. Start anvil with --chain-id 4663.`);
}

execFileSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", ANVIL_KEY],
  {
    cwd: contractsDir,
    stdio: "inherit",
    env: {
      ...process.env,
      OWNER: ANVIL_ACCOUNT,
      FEE_WALLET: ANVIL_ACCOUNT,
      UNIVERSAL_ROUTER: UNIVERSAL_ROUTER_ADDRESS,
      PERMIT2: PERMIT2_ADDRESS,
      SUITS_NFT: "0x0000000000000000000000000000000000000000",
    },
  },
);

// forge's broadcast log is the reliable source; the console.log line in the script is for a
// human reading the terminal.
type Broadcast = {
  transactions: { transactionType: string; contractName: string; contractAddress: string }[];
};
const runLatest = resolve(contractsDir, "broadcast/Deploy.s.sol/4663/run-latest.json");
if (!existsSync(runLatest)) die(`forge wrote no broadcast log at ${runLatest}.`);
const broadcast = JSON.parse(readFileSync(runLatest, "utf8")) as Broadcast;
const created = broadcast.transactions.find(
  (t) => t.transactionType === "CREATE" && t.contractName === "SVRouter",
);
if (!created || !isAddress(created.contractAddress)) {
  die("No SVRouter CREATE transaction in the broadcast log.");
}
const router = created.contractAddress as Address;

const body = [
  "# Written by scripts/fork/deploy-local.mts. Git-ignored, local fork only.",
  "# The key below is anvil's own published test account #0: public knowledge, funded only",
  "# on this fork, worthless anywhere else. Never put a real key in this file.",
  `NEXT_PUBLIC_RPC_URL=${rpcUrl}`,
  `NEXT_PUBLIC_SVROUTER_ADDRESS=${router}`,
  `FORK_PRIVATE_KEY=${ANVIL_KEY}`,
  "",
].join("\n");
writeFileSync(resolve(".env.fork"), body, { mode: 0o600 });

console.log(`\nSVRouter on the fork: ${router}`);
console.log(".env.fork written. Next: npm run fork:e2e");
