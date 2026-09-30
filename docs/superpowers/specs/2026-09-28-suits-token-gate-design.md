# Suits token gate — design

Date: 2026-09-28. Approved by Kobe in chat, 2026-09-28.

The whole app goes behind ownership of The Suits NFT. A holder sees LongMarkets exactly as
it is today. Everyone else sees one full-viewport lock screen and nothing else.

---

## 1. Verified facts

Read from Robinhood Chain (4663) on 2026-09-28, not taken from documentation:

| Fact | Value |
|---|---|
| The Suits NFT | `0x05c2174aa494bbdf72aeeab0ca3c10216d33b297` |
| `name()` / `symbol()` | `Suits` / `SUITS` |
| Standard | ERC-721 (`supportsInterface(0x80ac58cd)` → true; ERC-1155 → false) |
| `totalSupply()` | `3000` |
| Chain | **4663, the same chain the app already uses.** No cross-chain read, no network switch. |
| `SVRouter.suitsNft()` | `0x0000000000000000000000000000000000000000` — **no NFT configured** |
| `SVRouter.feeBps()` | `50` — everyone pays 0.5% |
| `SVRouter.holderFeeBps()` | `0` — inert, because `suitsNft` is zero |

OpenSea collection for non-holders: `https://opensea.io/collection/the-suits-nft`

## 2. Decisions taken (Kobe, 2026-09-28)

1. **Connect-only enforcement.** The gate is a client-side `balanceOf` check. No SIWE, no
   signature, no server enforcement. API routes stay publicly readable. This is a front door,
   not a vault; it buys exclusivity, not secrecy. The SIWE upgrade must remain additive.
2. **No auto-redirect.** A non-holder sees a denial state naming their wallet, with a button
   to the OpenSea collection. They are never navigated away without choosing to be.
3. **Everything is gated.** All routes: `/`, `/t/[address]`, `/traders`, `/watchlist`.

## 3. The bug this design exists to avoid

`useIsSuitHolder()` currently feeds `AppState.isHolder`, whose only consumer is the
`HolderBadge` in `src/components/WalletButton.tsx` — the badge that reads **"Suit holder,
0% fee"**.

The gate requires `NEXT_PUBLIC_SUITS_NFT_ADDRESS` to be set. It is empty today, so
`isHolder` is false for everyone and the badge never shows. **Setting that variable — which
the gate cannot work without — would light the badge up for every real holder while
`SVRouter` charges them 0.5%, because the router's `suitsNft` is the zero address.** The
docstring already in `suits.ts` warns about exactly this.

Therefore **access and the fee perk are two different questions and must be computed
separately**:

- **Access** = `balanceOf(Suits, wallet) > 0`. Drives the gate. Turns on now.
- **Fee perk** = access **and** `SVRouter.suitsNft()` is non-zero **and** equals
  `SUITS_NFT_ADDRESS`. Drives the badge. Stays off until Kobe calls `setSuitsNft`, then
  lights up on its own with no code change.

## 4. Components

### 4.1 `src/lib/suits.ts` — extend, do not rewrite

Keep `SUITS_NFT_ADDRESS` and `useIsSuitHolder` exported (existing call sites and tests
depend on them). Add:

```ts
export type SuitsAccess =
  | { status: "idle" }                          // no wallet connected
  | { status: "checking" }                      // read in flight
  | { status: "granted"; count: bigint }        // balanceOf > 0
  | { status: "denied"; count: bigint }         // balanceOf === 0n, confirmed
  | { status: "error"; retry: () => void };     // RPC failed — NOT a denial

export function useSuitsAccess(address?: Address): SuitsAccess;
```

Why a status and not a boolean: a boolean collapses "the RPC blipped" into "you own
nothing", which would tell a genuine holder they are not one. `denied` must mean the chain
answered zero. Use wagmi's `isLoading` / `isError` / `refetch` from `useReadContract` to
distinguish them.

Gate config:

```ts
/** The gate is on unless explicitly turned off, and off when no NFT address is configured
 *  (a local build with an empty env var must not lock its own developer out). */
export function gateEnabled(): boolean;
```

`gateEnabled()` is false when `NEXT_PUBLIC_TOKEN_GATE === "off"` or `SUITS_NFT_ADDRESS` is
unset. When the address is unset in a production build, warn once on the console.

**Fee-perk split.** `useIsSuitHolder` must additionally require that the router actually
grants the perk: read `SVRouter.suitsNft()` (selector `0x7c376492`, returns `address`) from
`SVROUTER_ADDRESS` in `src/lib/chain.ts`, and return true only when it is non-zero and
equals `SUITS_NFT_ADDRESS` case-insensitively **and** the wallet's balance is positive. When
`SVROUTER_ADDRESS` is undefined, the perk is false. Preserve the existing
`NEXT_PUBLIC_MOCK_SUIT_HOLDER` fallback for the no-address case exactly as it behaves today.

### 4.2 `src/components/TokenGate.tsx` — new client component

```tsx
export default function TokenGate({ children }: { children: ReactNode }): ReactElement;
```

Reads `address` / `isConnected` from wagmi (or `useAppState()`, matching house convention of
composing once), then `useSuitsAccess(address)`.

- `gateEnabled() === false` → render `children`.
- `status === "granted"` → render `children`.
- anything else → render `<LockScreen access={…} />` and **nothing else**. No `TopBar`, no
  `main`.

Locked is the default while the answer is unknown, so the app never flashes to a non-holder.

**Superseded during the build — no mount gate.** This section originally called for one, on the
assumption that the server render never has a wallet. It does: `Providers.tsx` seeds wagmi from
a cookie, wagmi's `hydrate` sets `status: 'reconnecting'` carrying the cookie's connections, and
`getConnection` returns the address for that status — so the address is present, and identical,
on the server render and the client's hydration render. There is no mismatch to prevent. Pinning
the address to `undefined` until after mount would only make both renders report `idle`, whose
copy is a lie for a wallet the tree already knows about and whose CONNECT WALLET button is inert
anyway (RainbowKit returns `openConnectModal: undefined` while reconnecting). Passing the address
straight through leaves `balanceOf` unresolved on both renders, so both say `checking`: identical
trees, honest copy. `TokenGate` also hands `address` to `LockScreen` as a prop, so the wallet the
denial copy names is always the wallet the balance was read against.

### 4.3 `src/components/LockScreen.tsx` — new client component

One frame, four contents. The frame never moves; only the middle block swaps.

**Frame.** `min-h-[100dvh]`, `bg-void`, flex-centered. A single centered column,
`max-w-[380px]`, `px-4 tablet:px-5`, held between two **full-bleed** `border-hairline`
rules (the band). Everything centered.

**Fixed furniture, top to bottom:**

| Element | Spec |
|---|---|
| Suits mark | `<SuitsMark size={64} />`, existing component, `opacity-90`. The app caps at 44px; this hero exception is deliberate and documented here. |
| Wordmark | `font-script text-[28px] leading-none text-chalk` = `SuitVentures`, then `font-mono text-[10px] uppercase tracking-[0.22em] text-ink-50` = `Markets`. Mirror `TopBar`'s `flex items-baseline gap-2`. |
| Eyebrow | `font-mono text-[9.5px] uppercase tracking-[0.28em] text-ink-40`. Content is state-dependent. |
| Headline | `text-[20px] leading-[1.3] text-ink` (sans, weight 400). |
| Sub-copy | `text-[12.5px] leading-[1.55] text-ink-50 text-pretty`. |
| Action | state-dependent, see below. |
| Footnote | `font-mono text-[9.5px] tracking-[0.14em] text-ink-34`: `3,000 SUITS · 0x05c2…b297` where the address links to `addressUrl()` from `src/lib/chain.ts` (Blockscout), `target="_blank" rel="noreferrer"`, hover `text-ink-50`. |

**The four states:**

| `status` | Eyebrow | Headline | Sub | Action |
|---|---|---|---|---|
| `idle` | `HOLDERS ONLY` | `This floor is for Suits.` | `LongMarkets is open to holders of The Suits NFT. Connect your wallet to check.` | **chalk primary** `CONNECT WALLET` → `openConnectModal()` |
| `checking` | `VERIFYING` | `Checking the guest list.` | `Reading the chain for your Suits.` | existing `<Spinner />`, no button |
| `denied` | `NOT ON THE LIST` | `No Suit on this wallet.` | `` `${short(address)} holds 0 Suits.` `` then `A Suit is the key to LongMarkets.` | **chalk primary** `GET A SUIT ↗` → OpenSea, new tab; **outline** `USE ANOTHER WALLET` → `openAccountModal()` |
| `error` | `HOLDERS ONLY` | `Couldn't reach the chain.` | `We couldn't read your Suits balance. This is us, not you.` | **outline** `RETRY` → `access.retry()` |

`error` must never render denial copy.

**Button recipes — reuse, do not invent:**

- chalk primary (from `TradePanel`): `h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white`
- outline (from `page.tsx` Retry): `h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)]`

**House rules that hold:** zero border radius except the circular mark; 1px hairlines only;
no gradient, no glow, no filled card, no drop shadow. Flat `--color-void` ground.

**Motion — the single new thing.** One entrance on mount: 240ms opacity 0→1 plus
`translateY(2px)→0`, `ease-out`. Define keyframes in `globals.css` next to the existing
`shimmer` / `ring-spin`, and disable under the existing
`@media (prefers-reduced-motion: reduce)` block. Scoped to this screen; the rest of the app
keeps its no-transition policy.

**Accessibility:** the lock screen is the whole document. Headline is the `<h1>`. Wrap in
`<main>`. The state region carries `aria-live="polite"` so the swap from checking → denied is
announced. `<SuitsMark>` is decorative (`alt=""`, already). Every control is a real `<button>`
or `<a>`, reachable and visibly focusable.

### 4.4 `src/app/layout.tsx` — mount

Wrap `TopBar` and `main` in `<TokenGate>`, inside `Providers` (it needs wagmi context).
`ToastStack` and `SignModal` stay outside the gate — they are portals owned by providers.

```tsx
<Providers cookies={cookies}>
  <TokenGate>
    <TopBar />
    <main>{children}</main>
  </TokenGate>
  <ToastStack />
  <SignModal />
</Providers>
```

### 4.5 Config

`.env.example` and `.env.local`:

- `NEXT_PUBLIC_SUITS_NFT_ADDRESS=0x05c2174aa494bbdf72aeeab0ca3c10216d33b297`
- `NEXT_PUBLIC_TOKEN_GATE` — documented; `off` lifts the gate for public launch with no code
  change. Defaults to on.

Document in `.env.example` that setting the NFT address no longer implies the fee perk.

## 5. Tests

Environment is chosen by extension: `.test.tsx` → jsdom, `.test.ts` → node. Component and
hook tests must be `.tsx`. Import render helpers from `@/test/dom`, never from
`@testing-library/react` directly. Mock wagmi with the `vi.hoisted()` pattern already used in
`src/lib/suits.test.tsx` and `src/app/watchlist/page.test.tsx`.

- `src/lib/suits.test.tsx` — extend. `useSuitsAccess` returns each of the five statuses;
  `error` is distinct from `denied`; `gateEnabled()` honours the flag and the empty address;
  `useIsSuitHolder` is **false** when the router's `suitsNft` is zero even though the wallet
  holds Suits (this is the regression test for §3), and true when it matches.
- `src/components/LockScreen.test.tsx` — each of the four states renders its own headline;
  the denial state shows the truncated address and links to the OpenSea collection; the error
  state shows Retry and calls `retry`; the error state does **not** render denial copy.
- `src/components/TokenGate.test.tsx` — children render only on `granted`; every other status
  renders the lock screen and not the children; `gateEnabled() === false` renders children
  regardless of status.

## 6. Out of scope

Server-side enforcement, middleware, SIWE-backed holder proof, per-route exceptions,
rate-limiting the RPC read. The hook's shape keeps all of these additive.

## 7. Decision Log

`README.md` gets **D44**, recording that the initial release is gated to Suits holders, with
the NFT address, the connect-only enforcement level, and the fact that this overrides §1's
"Browsing is open to anyone".

## 8. What changed during the build

Recorded so this document matches the code rather than the plan.

1. **No mount gate in `TokenGate`** — see §4.2. The premise was wrong; the gate would have
   shown returning holders a false `idle` state behind a dead button.
2. **`useSuitsAccess` decides in a different order** than "loading, error, data". `isLoading`
   is false on the render where `enabled` flips true, while `data` is still `undefined`, so
   ordering on it reported a still-unknown balance as a confirmed zero and flashed "no Suit"
   at genuine holders. The order that cannot lie is: an answer we hold, then error, then
   checking. A held answer also survives a failing background refetch, so one bad read does
   not evict a holder who is already inside.
3. **`refetchOnWindowFocus: true` on the balance read**, against the app's global default. A
   denied visitor's only way out is buying a Suit in another tab; without it they would sit on
   "No Suit on this wallet" until they thought to reload. Chosen over a third button.
4. **`LockScreen` takes `address` as a prop** rather than calling `useAccount()` itself, and
   falls back to "This wallet holds 0 Suits." when there is none (`short(undefined)` is `""`,
   which opened the sentence on a bare space).
5. **The band moved off `<main>`.** `border-y` on a `min-h-[100dvh]` element pins the rules to
   the extreme edges of the viewport, where a 9%-opacity cream line is invisible. They now
   bracket the column with 72px of air.
6. **`focus-visible:outline-solid`, not `focus-visible:outline`.** In Tailwind v4 `outline-none`
   sets `--tw-outline-style: none` unconditionally and the bare `outline` utility resolves
   `outline-style` from that variable, so the ring had a width and a colour and painted nothing
   — on the only screen a non-holder ever sees. Now asserted in `LockScreen.test.tsx`.
7. **Focus is moved to the headline when the state swaps** and focus was actually dropped to
   `<body>`, since every control lives inside the region that is replaced.
8. **`.env.example` ships the NFT address blank**, with the live value in a comment beside it.
   Shipping it set meant `cp .env.example .env.local` gated a fresh checkout, locking out any
   developer who does not own a Suit and the anvil fork harness, which signs with accounts that
   hold none.
9. **Typography** — `text-balance` over `text-pretty`, non-breaking spaces inside "The Suits
   NFT", and a 44px floor under the action slot so the footnote does not hop between states.
10. **The wall** (added 28 Sep after Kobe called the first build too plain). The original §4.3
    was a centred column on a flat ground, and it read as plain for a reason: it was an NFT gate
    showing none of the NFT. The screen is now framed top and bottom by two full-bleed rows of
    real Suits artwork, drifting in opposite directions at ~22px/s, dimmed to 42%, with the copy
    held between them. The headline grew from 20px to 30/40px to hold its own against them, and
    the hero `SuitsMark` shrank from 64px to 40px, since the wall now carries the visual weight.

    The tiles are **static files** in `public/suits/` (18 token ids, 240px, JPEG q68, ~15 KB
    each, 296 KB total), not a live `tokenURI` read: the art is on IPFS behind a public gateway
    that is slow and sometimes refuses (`ipfs.io` and `dweb.link` both failed; Pinata answered),
    and the originals are 3000px PNGs of 1–4 MB. The gate is the one screen that must render
    instantly for someone who is not yet a member. They are rendered with a plain `<img>` rather
    than `next/image` — decorative, fixed-size, already optimised, and the responsive tile size
    makes `next/image` warn once per tile, 18 times a load.

    Each wall renders its list twice and translates `-50%`, so the loop has no seam; a test
    asserts the doubling. Both walls are `aria-hidden` with empty `alt`, and both hold still
    under `prefers-reduced-motion`.

**Known and accepted, not fixed:** `gateEnabled()` fails open. A production build missing
`NEXT_PUBLIC_SUITS_NFT_ADDRESS` ships fully ungated and says so only in a console warning. The
spec mandated this shape so a local checkout cannot lock out its own developer, but it means the
address is required config for any environment meant to be gated. A build-time assertion is the
obvious hardening if Kobe wants it.

## 9. Amendment, 30 Sep 2026: TokenFacts moves below the app, and becomes a disclosure

The `/t/[address]` exemption in section 4.2 gave `TokenFacts` a public, server-rendered facts
layer, but it rendered first on the page, above `GatedSection`. On a phone its fifteen rows filled
the whole screen before a visitor reached the chart or the price, which is what the app is for.
Kobe asked for it moved down and made optional to read.

**Placement.** `src/app/t/[address]/page.tsx` now renders `<GatedSection>` first and `<TokenFacts>`
second. `TokenFacts` took a `launchedTx` prop to match: a page opened from `/launch`'s redirect has
no pair yet either, and `TokenView` (now above it, inside `GatedSection`) already shows the one
true message for that wait, a countdown then, corrected in fix round 1 below, its own "on chain,
data is late" copy with a Retry button once five minutes pass with nothing. `TokenFacts` stays
silent whenever `launchedTx` is present, rather than adding a second, contradictory message under
either one. The plain unknown-token wording, for a page with no pair and no launch in play, is
unchanged.

**Disclosure.** The fifteen rows now sit inside a native `<details>`, opened by a `<summary>`
reading "Token details" plus the ticker and name. A new small Client Component,
`src/components/TokenFactsDetails.tsx`, owns the open/closed state: closed by default for a
viewer the gate admits (a holder, or anyone once the gate is off), since the app above already
shows the same numbers, and open by default for everyone else, so the public page still carries
its facts without a click. The rows themselves stay `children` handed down from the Server
Component, so they remain real text in the SSR HTML and the disclosure works with no JavaScript
at all: a closed `<details>`'s content stays in the HTML, just visually collapsed, and a crawler
or a no-JS browser still gets the server's own default. `open` is derived during render from
`gateEnabled()` and `useSuitsAccess()`, never written with a state setter inside an effect and
never poked at the DOM by hand, so the client's first render matches the server's exactly and a
viewer's own manual toggle is never snapped back by an unrelated re-render.

**Colour and the fee tier.** The 1h and 24h change rows now use the same up/down/neutral colour
classes as the pairs table and the token header (`toneClassOrFlat`). The Pool fee tier row keeps
its value and gains one sentence under it: a token launched here states the split from its own
`creatorShareBps`, a dynamic fee explains that the pool's hook decides it per trade, and any other
fixed tier states the percentage without naming who receives it, since that differs by launchpad.

## 10. Fix round 1, 30 Sep 2026

A review of this section's own build (token-page-review.md) found five things worth changing:

- **One "No token" message, not two, for a plain unknown address too.** Section 9 above only
  covered the `?launched=` case. `page.tsx` now tells `TokenView` whether its own server read
  already had the pair (`serverHadPair`); when it did not, and there is no launch in play,
  `TokenView` renders only its back link, leaving the one message to `TokenFacts`.
- **The fee split only prints for a token's own launch pool.** `feeTierNote` now checks
  `pair.launch && pair.origin === "SV"`, not `pair.launch` alone, since a token launched here can
  later be listed through a different, traded pool whose fee does not go where the launch's does.
- **One shared helper for the token lookup**, `src/app/api/_lib/pairLookup.ts`, used by the token
  page, the token API and the quote route: one key, one ttl, one rule that a miss is never
  memoised, and a malformed address answers null with no database read at all.
- **The details disclosure closes while the Suits check is running, not just once it answers.**
  `open` in `TokenFactsDetails.tsx` is now true only for `idle`, `denied` or `error`; `checking`
  closes it. A connected wallet, holder or not, now renders closed from its very first paint,
  server and client alike, so a holder no longer sees the block open and then collapse on a hard
  load or an account switch. Crawlers and disconnected visitors still get it open in the SSR HTML.
- **The summary line's contrast, tap target and wrap.** The opacity that dimmed the whole summary
  is gone; the row is at least 40px tall; "Token details" no longer breaks across two lines at a
  phone's width.
