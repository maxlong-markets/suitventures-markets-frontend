import { USDG, ZERO_ADDRESS } from "@/lib/chain/math/constants";
import type { QuoteRow } from "@/lib/chain/math/quotes";

/**
 * The launchpad's deploy config (instant launchpad design, section 8.3): every quote the reader recognises, so the
 * contract's allowlist can never hold a currency whose pools the reader would ignore. The contracts repo's
 * `script/DeployLaunchpad.s.sol` reads it from `script/config/launch-currencies.json`. DEFAULT bounds (spec 12):
 * USD 5,000 to 10,000,000 per currency, pending MAXLONG's confirmation.
 */
export const MIN_USD = 5_000;
export const MAX_USD = 10_000_000;
/** Raw quote units, as a string: the contracts script parses an integer string. */
export const CREATION_FEE = "0";
/**
 * Documentation only, never written to the file: `referenceUsdPrice` is an integer string with this many decimals, so
 * USD 300.25 is "30025000000"; "0" means "not filled in yet" and the deploy script refuses to run on it.
 */
export const REFERENCE_PRICE_DECIMALS = 8;

export type CurrencyPriceSource = "chainlink" | "pinned" | "reference";
/** Key order is the contracts script's canonical order; the object literal below builds it in exactly this order. */
export type CurrencyConfigRow = {
  address: string;
  symbol: string;
  decimals: number;
  /** chainlink: read `latestRoundData` on the proxy; pinned: USDG at exactly 1 (the only pinned row); reference: `referenceUsdPrice`. */
  priceSource: CurrencyPriceSource;
  /** The zero address unless priceSource is "chainlink". */
  chainlinkProxy: string;
  /** 0 unless priceSource is "chainlink". */
  chainlinkDecimals: number;
  referenceUsdPrice: string;
};
export type CurrencyConfigFile = {
  minUsd: number;
  maxUsd: number;
  creationFee: string;
  currencies: CurrencyConfigRow[];
};

export function currencyConfig(rows: readonly QuoteRow[]): CurrencyConfigFile {
  const currencies = rows
    .map((q): CurrencyConfigRow => {
      const address = q.address.toLowerCase();
      const pinned = address === USDG;
      const feed = !pinned && q.chainlinkProxy !== null && q.chainlinkDecimals !== null;
      return {
        address,
        symbol: q.symbol,
        decimals: q.decimals,
        priceSource: pinned ? "pinned" : feed ? "chainlink" : "reference",
        chainlinkProxy: feed ? q.chainlinkProxy!.toLowerCase() : ZERO_ADDRESS,
        chainlinkDecimals: feed ? q.chainlinkDecimals! : 0,
        referenceUsdPrice: "0",
      };
    })
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { minUsd: MIN_USD, maxUsd: MAX_USD, creationFee: CREATION_FEE, currencies };
}
