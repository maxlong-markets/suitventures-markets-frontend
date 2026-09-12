# Handoff: SuitVentures Markets — frontend

Paste-ready brief for Claude Code. Build the frontend exactly as specified here; the bundled `App.dc.html` is the interactive reference (open it in a browser — every state is clickable). Wire it to mock data behind a typed adapter so the Envio/Alchemy layer plugs in later without touching components.

## Prompt to paste into Claude Code

> Implement the SuitVentures Markets frontend described in `design_handoff_suitventures_markets/README.md`. Recreate the design pixel-for-pixel from that spec (the HTML in the folder is a reference prototype, not code to copy). Use Next.js (App Router) + TypeScript + Tailwind, matching the conventions already in `SuitsNFT-frontend` (Tailwind v4 `@theme` tokens, wagmi + RainbowKit for wallet, Helvetica Neue + a mono font). All data comes through the `MarketsDataSource` interface defined in the README; ship a `MockDataSource` seeded with the token list in the README, and leave the swap/sign calls as clearly-marked stubs. No dynamic data yet — but every component must consume the typed models, not literals.

## About the design files

- `App.dc.html` — the working prototype (design reference in HTML). Open in a browser at 1440px, 834px and 390px to see the responsive behaviour and every state. It runs entirely on mock data.
- `suits-mark.png` — the Suits mark (512×512). Used at 22px (top bar), 16px (holder badge), 32px (favicon), 36–44px (modals).
- `snippets/*.png` — 1440px captures of the six key screens for visual comparison.

**Fidelity: high.** Colors, type, spacing and copy are final. Recreate them exactly.

## Product summary

A mobile-first web app (not a mobile app; no bottom tabs) that lists every memecoin pair on Robinhood Chain (chain id 4663) launched via LONG, Pons, Bags or the SuitVentures factory, and lets users swap through the SuitVentures router. Suit NFT holders pay 0% router fee; everyone else 0.5%. Two pages: **Markets** and **Watchlist**, plus a **Token page**. Voice: dry, financial. No menswear puns in UI copy (they were removed); plain words everywhere.

---

## Design tokens

### Color (dark only — there is no light mode)
| Token | Value | Use |
|---|---|---|
| `void` | `#050506` | page background |
| `panel` | `#0C0C0F` | modals, toasts, popovers |
| `ink` | `#F1EFE9` | primary text |
| `ink-85` | `rgba(232,228,220,0.85)` | secondary emphasis |
| `ink-60` | `rgba(232,228,220,0.6)` | secondary text |
| `ink-50` | `rgba(232,228,220,0.5)` | inactive nav, body-muted |
| `ink-45` | `rgba(232,228,220,0.45)` | labels, addresses |
| `ink-40` | `rgba(232,228,220,0.4)` | table headers, rank |
| `ink-34` | `rgba(232,228,220,0.34)` | placeholders, tertiary |
| `hairline` | `rgba(240,232,214,0.09)` | dividers, card borders |
| `hairline-strong` | `rgba(240,232,214,0.14)` | input/chip/modal borders, header rule |
| `hairline-row` | `rgba(240,232,214,0.07)` | table row dividers |
| `hover-row` | `rgba(232,228,220,0.045)` | row hover fill |
| `chalk` | `#F4EEDA` | the single accent: primary button, active states, starred, selected |
| `chalk-10` | `rgba(244,238,218,0.1)` | active segment fill |
| `up` | `#5DBE8A` | positive change, Buy side, bullish |
| `down` | `#D46A63` | negative change, Sell side, bearish |
| `up-vol` | `rgba(93,190,138,0.26)` | volume bars (up candles) |
| `down-vol` | `rgba(212,106,99,0.26)` | volume bars (down candles) |
| `tag` | `#2A2A31` | crosshair axis tags |
| `logo-shades` | `#1C1C21 #232329 #2A2A31 #1A1A1F #2E2E36 #212127` | placeholder token avatars (hash of ticker → shade) |

Rules: black/white/greys for structure; green/red **only** for price change, side and bull/bear; chalk cream **only** for the primary action and active/selected states. No gradients, no glows, no filled cards — hairline borders only. Corner radius: 0 everywhere except circles (avatars, marks, spinner). Skeleton shimmer is the one permitted gradient.

### Typography
- **Sans**: `"Helvetica Neue", Helvetica, Arial, sans-serif` — headings, names, body, preset labels.
- **Mono**: `"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace` with `font-variant-numeric: tabular-nums` — every number, address, label, nav item, button.
- **Script**: `Yellowtail` (Google Fonts) — wordmark only.

| Style | Spec |
|---|---|
| Wordmark | Yellowtail 22px, `chalk`, line-height 1, + "MARKETS" mono 9.5px / 0.22em / uppercase / ink-50, baseline-aligned, gap 8px |
| Nav / labels | mono 10.5px, letter-spacing 0.22em, uppercase; active ink, inactive ink-50 |
| Small label | mono 10px, 0.18em, uppercase, ink-45 |
| Table header | mono 10px, 0.16em, uppercase, ink-40; active-sort caret ▲/▼ in ink |
| Table data | mono 12.5px tabular |
| Ticker in row | sans 13px / 500, letter-spacing 0.01em |
| Row sub-line | sans 11px, ink-45 |
| Badge | mono 8.5px, 0.14em, padding 1px 4px, 1px `hairline-strong` border, ink-60, line-height 1.3 |
| Token page ticker | sans 20px / 500, letter-spacing −0.01em |
| Token price | mono 28px, line-height 1, letter-spacing −0.01em |
| Trade input | mono 20px |
| Output amount | mono 22px, letter-spacing −0.01em |
| Primary button | mono 11px, 0.22em, uppercase |
| Small button (Connect) | mono 9.5px, 0.22em, uppercase |
| Body / modal copy | sans 12.5–13px, line-height 1.55 |
| Page h1 (Watchlist) | sans 18px / 500 |

### Spacing & sizes
- 8px grid. Horizontal page gutter: 24px desktop, 20px tablet, 16px phone.
- Top bar 56px; chips row 26px chips with 12px vertical padding; presets/launchpad controls 28px; table header 32px; rows 44px (regular density); token page trade panel 360px wide; chart height 332px; buttons 44px (primary), 34px (header actions), 32px (top bar); inputs 52px (amount), 32px (search).

### Breakpoints (container width)
- **Phone** `< 680px`
- **Tablet** `680–1179px`
- **Desktop** `≥ 1180px`
- Token page goes two-column at `≥ 960px`; token header stacks below `1000px`.

---

## Global elements

### Top bar (56px, hairline-strong bottom rule)
Left: Suits mark 22px circle (`object-fit: cover`, `box-shadow: 0 0 0 1px rgba(240,232,214,0.16)`) + wordmark; then nav **Markets · Watchlist** (gap 22px, 30px from the wordmark). Right: search input (220px desktop / 160px tablet, 32px tall, hairline-strong border, magnifier icon 12px at left 10px, placeholder "Ticker or address", focus border `rgba(244,238,218,0.55)`) and the wallet button.

Wallet button: 32px, padding 0 14px, 1px `rgba(255,255,255,0.3)` border, transparent, mono 9.5px/0.22em uppercase, hover border `rgba(255,255,255,0.75)` + bg `rgba(255,255,255,0.08)`.
- Disconnected: "Connect Wallet" → opens connect modal.
- Connected: truncated address `0x3f8A…9A2c` (first 6 + last 4). If the wallet holds a Suit, a 16px Suits mark precedes it with a tooltip on hover: **"Suit holder, 0% fee"** (panel bg, hairline-strong border, mono 9.5px, positioned 26px below).
- Phone: nav moves to a second row under the bar (scrollable), search collapses to a 32px icon button that toggles a full-width input row.

### Quote chips row (hairline bottom rule)
`ALL` + top quotes by 24h volume (8 on desktop, 6 tablet, 4 phone) + any selected quote not in that set + a dashed **"+N more ▾"** button + a "Clear" text button when anything is selected. Chip: 26px, padding 0 11px, mono 10px/0.14em, 1px `hairline-strong` border, ink-60; **active = inverted** (bg `ink`, text `#050506`, border ink). Multi-select: clicking toggles a quote; `ALL` clears. Hover border `rgba(240,232,214,0.45)`.

**Quote picker popover** (anchored under the chips row, left = gutter, max-width 520px, panel bg, hairline-strong border): search input "Find a quote asset" + "24 QUOTES" count; sortable header **Asset · Pairs · Vol 24h** (click toggles ▲/▼); rows 36px with a 14px checkbox (border `rgba(240,232,214,0.3)`; checked = chalk fill + `#050506` ✓), symbol (mono 11.5px ink) + name (sans 11px ink-45), pairs count, volume; list max-height 312px scroll; footer "N selected · PLTR, HIMS" / "Showing every quote asset" + **Clear** (hairline) and **Done** (chalk) 28px buttons.

---

## Page: Markets

Toolbar row (padding 14px 0, wraps): **presets segmented** (All · Top volume · Gainers · New · Most holders — sans 11.5px, 28px tall, hairline-strong group border, separators, active = `chalk-10` bg + chalk text), **Launchpad** label + segmented (All · LONG · PONS · BAGS · SV — mono 9.5px/0.14em; label hidden on phone), and a right-aligned count "16 PAIRS · PLTR, HIMS" (mono 10.5px/0.14em uppercase ink-40).

Preset semantics: Top volume → sort vol desc; Gainers → filter `h24 > 0 && liquidity > $10K`, sort h24 desc; New → filter `age ≤ 7d`, sort age asc; Most holders → sort holders desc; All → vol desc. Clicking a column header afterwards re-sorts within the preset.

### Table (CSS grid rows, 8px column gap; horizontal scroll fallback)
Desktop columns → tracks:
`# 28 · Token minmax(120px,1fr) · ★ 22 · Quote 64 · Price 92 · 1h 62 · 24h 62 · Vol 24h 90 · Mcap 90 · FDV 90 · Liquidity 90 · Holders 68 · Age 44 · Votes 96`
Tablet (hides FDV, Holders, Age):
`22 · minmax(104px,1fr) · 22 · 56 · 78 · 54 · 54 · 80 · 76 · 74 · 88`
Phone: `Token minmax(0,1fr) · Price 76 · 24h 54 · Vol 60`

Cells:
- **#** rank after sort/filter, mono 11px ink-40.
- **Token**: avatar 22px circle (logo, or initial on a `logo-shade`), ticker (sans 13/500) + launchpad badge inline right after it (LONG / PONS / BAGS / SV), sub-line name in sans 11px ink-45. Phone sub-line: `name · QUOTE · LAUNCHPAD` (no inline badge).
- **★** 28px hit area; `☆` ink-34 when off, `★` chalk when starred; hover chalk. Click stops row navigation.
- **Quote**: `/ NVDA` mono 11.5px ink-60.
- **Price**: `$0.1943` (≥1000 → 2dp with commas; ≥1 → 2dp; ≥0.01 → 4dp; ≥0.0001 → 6dp; else 8dp).
- **1h / 24h**: `+4.21%` / `−17.69%` (true minus U+2212), 2dp, `up`/`down`, 0 → ink-50.
- **Vol / Mcap / FDV / Liquidity**: `$4.18M`, `$918.4K`, `$1.20B`.
- **Holders**: `18,423`. **Age**: `2h · 17d · 2mo` (m/h/d/mo).
- **Votes**: two right-aligned sub-columns (grid 1fr 1fr, gap 8px): `↑1,240` in `up`, `↓388` in `down`, arrows at 55% opacity; headers "BULL" / "BEAR".
- Row: 44px, `hairline-row` bottom border, hover `hover-row`, cursor pointer → token page. All row text nowrap.
- Sorted column shows ▲/▼ in ink next to its header; header click toggles direction (default desc, except Age/Token asc).

Phone: tap a row to expand inline (padding 6px 0 14px 32px): 2-col grid of label/value pairs with dotted separators — 1h, Mcap, FDV, Liquidity, Holders, Age, Votes — then a row with `☆ Watch` (hairline 32px) and **OPEN {TICKER} →** (chalk, flex 1). Second tap collapses; Open navigates.

States:
- **Loading**: 8 skeleton rows, 22px circle + four bars (10px tall, widths vary) with shimmer `linear-gradient(90deg, rgba(232,228,220,.05) 25%, rgba(232,228,220,.11) 50%, rgba(232,228,220,.05) 75%)`, background-size 200%, 1.4s linear infinite; count label reads "LOADING".
- **Empty (filter)**: centered, padding 64px: "No pairs match." (sans 16px) + "No {PLTR / HIMS} pairs on {LONG} match {Gainers}." or "No pair matches “{query}”." (12.5px ink-50) + **SHOW ALL PAIRS** hairline 30px button that resets quotes, launchpad, preset, query.
- Footnote under the table when showing mock rows beyond the eight real pairs: mono 10px ink at 30% opacity.

---

## Page: Watchlist

Same table filtered to starred tokens; title row "Watchlist" (sans 18/500) + "3 TOKENS" (mono 10.5px/0.16em ink-40), then the same toolbar. Requires a connected wallet:
- Disconnected: centered block (padding 72px), 36px Suits mark at 80% opacity, "Your watchlist lives with your wallet." (17px), "Connect to see the tokens you've starred." (12.5px ink-50), **CONNECT WALLET** button.
- Empty: "Nothing on your watchlist yet." + "Star a token in Markets to track it here."

---

## Page: Token

`← MARKETS` link (mono 10px/0.2em ink-45, 14px top margin).

**Header** (padding 18px 0, hairline bottom): left — 40px avatar; line 1 ticker (20/500) + name (13px ink-50) baseline-aligned; line 2 mono 11px: `AI / NVDA` (ink-65) · badge · `0x2E8c…1e18` · **COPY** (9.5px/0.16em uppercase; becomes "COPIED" for 1.4s). Right cluster — price block (mono 28px; below: `−17.69%` colored + `24h · 0.000866 NVDA` ink-40) then actions: ★ 34px square (hairline-strong border; chalk when starred), **↑ Bullish 1,240** and **↓ Bearish 388** 34px buttons (mono 11px, hairline-strong border; arrow + count in up/down; voted state = border `rgba(244,238,218,0.6)` + chalk text; counts increment on vote). Below 1000px the header stacks: identity row, then price + actions in one row (space-between); on phone price and actions get separate rows.

**Layout**: `≥ 960px` two columns — chart column flex 1 + trade panel 360px, gap 32px, margin-top 20px. Below: single column, **trade panel first**, gap 24px.

### Chart (hairline border box)
Toolbar 36px: interval tabs `1m 5m 15m 1h 1d` (24px, mono 10.5px; active `chalk-10` + chalk) left; "UNISWAP V4 · ROBINHOOD CHAIN" small label right.
Canvas/SVG height 332, right price axis 64px wide, plot = width − 64:
- Plot area y 70→270 (200px); volume histogram rises from y=306 up to 60px, drawn behind candles in `up-vol`/`down-vol`; time axis strip below y=306 (labels at 311–328); vertical hairline at plot/axis boundary and horizontal at y=306 in `rgba(240,232,214,0.12)`.
- Grid: 6 horizontal levels (hi→lo) and vertical lines at each time label, `rgba(240,232,214,0.06)`. Price labels mono 10px ink-45 at axis-left + 6px; time labels centered under their candle every 12 candles (`HH:MM` intraday, `Sep 4` on 1d).
- Candles: 72 visible; body width `floor(step × 0.66)` min 2; wick 1px and body both `up`/`down`.
- **Last price**: dashed line (2 3) across the plot in the last candle's color, 80% opacity, with a 64×17 filled tag on the axis (`#050506` text, 600 weight).
- **Legend** (HTML overlay, top 8px left 10px, mono 10.5px, line-height 1.6): `AI / NVDA · 15m · Uniswap v4`; `O 0.1954 H 0.1968 L 0.1942 C 0.1943 −0.001132 (−0.58%)` values colored by that candle's direction; `Vol $45.9K`. Follows the crosshair, else the last candle.
- **Crosshair**: dashed (3 3) `rgba(232,228,220,0.5)` vertical + horizontal lines; price tag (`tag` bg, ink text, 64×17) on the right axis, time tag (padding 0 8px) on the time axis. Cursor `crosshair`.
- Watermark: pair name sans 38px/500 at 4.5% ink, centered in the plot.
- Render with lightweight-charts or an SVG/canvas of your own — must match the above visually.

### Tabs under the chart (margin-top 26px)
`TRADES · HOLDERS · INFO` — mono 10.5px/0.22em, 34px, active = ink + 1px ink underline, inactive ink-50. Content mono 12px, rows 32px, `rgba(240,232,214,0.06)` dividers, hover `rgba(232,228,220,0.035)`.
- **Trades** columns `Time 72 · Side 44 · Amount 1fr · Price 1fr · Wallet 110 · Tx 24` (phone drops Wallet): `13:41:05`, `Buy`/`Sell` colored, `15,749 AI`, `$0.1941`, `0xce73…6329`, `↗` link to Blockscout.
- **Holders** `# 32 · Wallet 1fr · Balance 120 · Share 90`: rank, address (+ optional badge `Pool` / `Suit`), `84,684,155`, `8.47%`.
- **Info** key/value rows (label mono 10px/0.16em uppercase ink-40 left, value right): Pool, Hook (`Doppler shared v4 hook` / `Pons MemeHook · afterSwap` / `None`), Fee tier (`Dynamic · 0.30% now` / `1.00% hook fee` / `0.30%`), Created (`2026-07-14 · 2mo ago`), Liquidity (`$5.14M · 11,455.74 NVDA`), Quote (`NVDA · $224`).

### Trade panel (hairline border, padding 16px, 360px)
1. **Buy / Sell** segmented (2 equal cells, 32px, hairline-strong border; active `chalk-10` + chalk; inactive ink-50). Switching side clears the amount and resets denomination (buy → quote, sell → token).
2. Label row: `YOU PAY` (10px/0.18em ink-45) … `Balance 1,250 NVDA` right.
3. Amount input 52px: mono 20px, placeholder `0.00`, decimal-only; right inside: denomination toggle `NVDA ⇅` (32px, hairline-strong) — switches whether the typed amount is the pay asset or the receive asset; labels swap to `YOU RECEIVE` / `YOU PAY` accordingly.
4. Quick amounts `25% 50% 75% Max` (4 equal 26px hairline buttons) — set the pay amount from balance.
5. Output block: label, then `115,492 AI` (22px) with `≈ $22.4K` right (11px ink-40).
6. Breakdown (hairline top, 11.5px, label ink-50 / value ink): Rate `1 AI = 0.000866 NVDA`; Price impact `0.87%` (turns `down` above 3%; `< 0.01%` floor; `—` when empty); Router fee `0% · Suit holder` in chalk, or `0.5%`; Pool fee `0.30% · Doppler` / `1.00% · MemeHook` / `0.30%`; Min. received `114,568 AI` (= receive × (1 − slippage − pool fee)); Network `Robinhood Chain · < $0.01`.
7. Slippage row: `SLIPPAGE` label … `Auto · 0.5%` + gear icon (click opens the popover). Value turns `down` above 1%.
8. **Primary button** 44px chalk bg, `#050506` text, hover `#FFFFFF`: `BUY AI` / `SELL AI`.
   - Disabled: 1px `rgba(240,232,214,0.12)` border, bg `rgba(244,238,218,0.06)`, text ink-34, cursor not-allowed, reason centered below (mono 10.5px ink-50): "Connect a wallet to trade." / "Enter an amount." / "Insufficient NVDA balance."
   - Pending: chalk at 55% bg, 12px spinner (1.5px ring, 0.9s), "CONFIRM IN WALLET", sub-line "Waiting for your signature."
   - Untradeable (pool can't be routed, e.g. Bags): the panel is replaced by a hairline card, centered: `NOT ROUTED` label, "Not tradeable here yet" (17px), "This Bags pool can't be routed through the SuitVentures swap. Trade it on Bags for now." (12.5px ink-50), **TRADE ON BAGS ↗** 34px outlined link.

**Slippage popover** (absolute, right 16px, bottom 74px, 240px, panel bg): `MAX SLIPPAGE` + ×; 4 options `Auto · 0.1% · 0.5% · 1%` (28px; selected `chalk-10` bg, chalk text, border `rgba(244,238,218,0.5)`); custom input with `%` suffix (30px); note "Your trade reverts if the price moves more than this before it confirms." or, above 1%, "High slippage. Your trade may fill at a worse price than quoted."

---

## Modals & toasts (absolute overlays inside the app root)

Overlay `rgba(5,5,6,0.78)`, content top-aligned with 72px top padding (16px sides). Click outside closes.

**Connect wallet** (720px, two columns on ≥680px; single column 400px on phone): left — "Connect a wallet" (16/500), `INSTALLED` label, wallet rows 44px (28px square initial tile on a logo-shade, name sans 13px, "RECENT" chalk tag on the last-used one; hover `rgba(232,228,220,0.05)` + hairline border): MetaMask, Rabby, Coinbase Wallet, WalletConnect. Right — × close, 44px Suits mark, "Your wallet is your key." (15/500), copy: "It holds your tokens and signs every trade. SuitVentures never holds funds and can't move anything without your approval." / "Hold a Suit in the connected wallet and the router fee drops to 0%." Links `GET A WALLET ↗` (chalk) · `LEARN MORE ↗` (ink-50). Use RainbowKit's modal with this theme.

**Sign message** (400px): 36px mark + ×; "Sign to save your watchlist" (or "Sign to cast your vote"); "A one-time signature ties your watchlist and votes to this address. No gas, no transaction, nothing moves."; message preview box (hairline, mono 10.5px ink-50): `SuitVentures Markets wants you to sign in with 0x3f8A…9A2c · Chain 4663 · Nonce 8fa2c1d0`; buttons **CANCEL** (hairline) / **SIGN MESSAGE** (chalk), 40px, 2-col grid.
Flow: first star or vote → if disconnected open Connect, then Sign, then apply the action. Signature is remembered for the session.

**Toasts** (bottom-right 16px, 320px, stacked 8px, panel bg, hairline-strong border, padding 12px 14px): 12px status dot — pending = spinner ring, confirmed = chalk filled circle, failed = hollow ring; `PENDING / CONFIRMED / FAILED` label (mono 9.5px/0.2em ink-45); message 12.5px; `View tx 0x8f3a…c21e ↗` (mono 10.5px ink-50) to Blockscout; × dismiss. Copy: "Buying 115,492 AI for 100 NVDA" → "Bought 115,492 AI for 100 NVDA" (auto-dismiss 7s) or "Swap failed. Price moved past 0.5% slippage; nothing was spent."

---

## Data layer (make it plug-and-play)

```ts
export type Launchpad = 'LONG' | 'Pons' | 'Bags' | 'SV';

export interface QuoteAsset { symbol: string; name: string; address: `0x${string}`; decimals: number; usdPrice: number; pairs: number; vol24h: number }

export interface TokenPair {
  ticker: string; name: string; address: `0x${string}`; logoUrl?: string;
  quote: string;                 // QuoteAsset.symbol
  launchpad: Launchpad; tradeable: boolean;   // false → "Not tradeable here yet" card
  priceUsd: number; priceQuote: number;
  change1h: number; change24h: number;        // percent
  vol24h: number; mcap: number; fdv: number; liquidity: number; holders: number;
  createdAt: number;                           // unix ms → age
  bull: number; bear: number;
  poolId: `0x${string}`; hook: string; feeTier: string;
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface Trade { t: number; side: 'buy' | 'sell'; amount: number; priceUsd: number; wallet: `0x${string}`; tx: `0x${string}` }
export interface Holder { wallet: `0x${string}`; balance: number; share: number; tag?: 'Pool' | 'Suit' }
export interface Quote { payAmount: number; receiveAmount: number; priceImpactPct: number; routerFeePct: 0 | 0.5; poolFeePct: number; minReceived: number }

export interface MarketsDataSource {
  quotes(): Promise<QuoteAsset[]>;
  pairs(): Promise<TokenPair[]>;
  candles(ticker: string, interval: '1m'|'5m'|'15m'|'1h'|'1d'): Promise<Candle[]>;
  trades(ticker: string): Promise<Trade[]>;
  holders(ticker: string): Promise<Holder[]>;
  quoteSwap(ticker: string, side: 'buy'|'sell', amount: number, denom: 'quote'|'token', isSuitHolder: boolean, slippagePct: number): Promise<Quote>;
  watchlist(address: `0x${string}`): Promise<string[]>;        // tickers
  setWatch(address: `0x${string}`, ticker: string, on: boolean, signature: string): Promise<void>;
  vote(address: `0x${string}`, ticker: string, dir: 'bull'|'bear', signature: string): Promise<void>;
}
```

Provide `MockDataSource` (deterministic, seeded — reuse the generator logic in `App.dc.html`'s script if convenient) and leave `EnvioDataSource` as a stub with TODOs. Wallet: wagmi + RainbowKit on chain 4663 (`https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`); `isSuitHolder = balanceOf(SuitsNFT, address) > 0` (address TBD — stub). Swap execution via `SVRouter` (stub) — UI already models pending/confirmed/failed.

### Seed data (the eight real pairs; the rest in the prototype are filler)
| Ticker | Name | Quote | Launchpad | Price | 1h | 24h | Vol 24h | FDV | Liq | Holders | Age | Bull / Bear |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AI | Artificial Inu | NVDA | LONG | 0.1943 | −2.69 | −17.69 | 4,180,389 | 192,265,217 | 5,141,337 | 18,423 | 1400h | 1240 / 388 |
| SUIT | The Suits | NVDA | LONG | 0.00412 | +1.12 | +6.84 | 212,640 | 4,108,700 | 318,200 | 2,210 | 960h | 402 / 19 |
| SPACEHOOD | Spacehood | SPCX | LONG | 0.0328 | +4.21 | +31.6 | 1,462,300 | 32,800,000 | 1,204,000 | 6,120 | 410h | 880 / 140 |
| BONER | Boner Coin | HIMS | LONG | 0.00891 | −0.84 | +12.4 | 684,200 | 8,910,000 | 402,100 | 3,480 | 720h | 512 / 97 |
| MOO | Moo | TSLA | LONG | 0.0512 | +0.32 | −4.18 | 918,400 | 51,200,000 | 2,210,000 | 7,940 | 1900h | 640 / 210 |
| CASHCAT | Cash Cat | ETH | Pons | 0.00174 | −1.4 | −9.6 | 402,300 | 1,740,000 | 186,400 | 1,980 | 300h | 220 / 88 |
| TENDIES | Tendies | ETH | Pons | 0.000612 | +2.9 | +44.2 | 388,900 | 612,000 | 98,200 | 1,120 | 38h | 310 / 42 |
| STONKBROKER | Stonkbroker | USDG | Bags | 0.0000482 | 0 | −2.1 | 12,400 | 48,200 | 9,100 | 214 | 14h | 12 / 9 (untradeable) |

Addresses: AI `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18`; SUIT `0x87A78590D563F0EFC62192239af46707FFF74386`. Quote USD used in the prototype: NVDA 224.4, TSLA 380.2, AAPL 245.1, SPY 655.3, HIMS 48.6, SPCX 210, PLTR 178.4, ETH 4480, USDG 1. Quote pair counts (Pons snapshot): NVDA 341, ETH 2770, USDG 1247, SPY 231, GME 184, DJT 157, RDDT 116, QQQ 103, AAPL 80, TSLA 75, PLTR 42.

Mcap = FDV × circulating ratio (SUIT 0.62 in the mock; default 1).

---

## State (client)
`page` (markets | watchlist | token), `token`, `selectedQuotes: string[]`, `launchpad: 'all' | Launchpad`, `preset`, `sortKey/sortDir`, `query`, `pickerOpen/pickerQuery/pickerSort`, `expandedRow` (phone), `wallet: none | connected | holder`, `signed`, `stars: string[]`, `votes: Record<ticker,'bull'|'bear'|null>`, `side`, `denom`, `amount`, `slippage` (+ `auto`, `custom`), `slippageOpen`, `tx: null | 'pending'`, `toasts[]`, `modal: null | 'connect' | 'sign'`, `pendingAction`, chart `interval`, `hoverIndex`, `tab`. Persist watchlist/votes server-side keyed by address once signed; everything else is ephemeral. Use URL routes: `/`, `/watchlist`, `/t/[ticker]`.

## Component inventory
`TopBar`, `WalletButton` (+ `HolderBadge` tooltip), `QuoteChips` + `QuotePicker`, `PresetSegmented`, `LaunchpadSegmented`, `PairsTable` (+ `PairRow`, `PairRowExpanded`, `SkeletonRow`, `EmptyState`), `TokenHeader`, `CandleChart` (+ `ChartLegend`), `ActivityTabs` (`TradesTable`, `HoldersTable`, `InfoList`), `TradePanel` (+ `SideToggle`, `AmountInput`, `QuickAmounts`, `Breakdown`, `SlippagePopover`, `PrimaryButton`, `UntradeableCard`), `ConnectModal`, `SignModal`, `ToastStack`, `Badge`, `Star`, `VoteButtons`.

## Formatting helpers (port exactly)
`fmtUsd` (B/M/K with 2/2/1 dp), `fmtPrice` (thresholds above), `fmtPct` (sign + 2dp, U+2212 minus), `fmtInt` (locale commas), `fmtAge` (m/h/d/mo), `fmtQuote` (4/6/8/10 dp by magnitude), `short(address)` = 6 + … + 4.

## Assets
- `suits-mark.png` — from the client (Suits NFT brand). Favicon and all mark sizes derive from it.
- Yellowtail — Google Fonts (already used by the SuitsNFT site).
- Token logos — `logoUrl` from the indexer; fall back to initial on a logo-shade circle.
- Icons: draw inline (magnifier = circle + line; gear = dashed ring + dot; stars/arrows are text glyphs ★ ☆ ↑ ↓ ↗ ⇅). No icon library needed.
