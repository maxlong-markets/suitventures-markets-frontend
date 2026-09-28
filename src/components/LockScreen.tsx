"use client";

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import type { Address } from "@/lib/types";
import type { SuitsAccess } from "@/lib/suits";
import { addressUrl } from "@/lib/chain";
import { short } from "@/lib/format";
import { Spinner, SuitsMark } from "./ui";

/** OpenSea's listing for The Suits — the only place a non-holder is sent to become one. */
const OPENSEA_URL = "https://opensea.io/collection/the-suits-nft";

/**
 * The Suits NFT collection address (design spec §1, a verified on-chain fact, not app
 * configuration). Kept local rather than read from `@/lib/suits`: the footnote names the
 * collection itself for anyone reading it, so it must keep rendering even in the — currently
 * unreachable — case where the gate's own env-derived address were ever unset.
 */
const SUITS_COLLECTION_ADDRESS = "0x05c2174aa494bbdf72aeeab0ca3c10216d33b297";

/**
 * The app has no focus-visible convention yet (design-handoff README is silent on it), so this
 * scopes one restrained, hairline-derived ring to the lock screen rather than inventing a global
 * default.
 *
 * `focus-visible:outline-solid`, not `focus-visible:outline`: in Tailwind v4 `outline-none` sets
 * `--tw-outline-style: none` on the element unconditionally, and the bare `outline` utility
 * resolves `outline-style` from that same variable — so the pair suppresses the native ring and
 * then paints a 1px ring with `outline-style: none`, which is zero visible pixels. Naming the
 * style explicitly in the focus state is what restores it. Asserted in LockScreen.test.tsx.
 */
const FOCUS_RING =
  "outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-[3px] focus-visible:outline-[rgba(244,238,218,0.55)]";

/** Chalk primary — the recipe from TradePanel's submit button, verbatim (spec 4.3). */
const PRIMARY_BTN = `h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white ${FOCUS_RING}`;

/** Outline — the recipe from page.tsx's Retry button, verbatim (spec 4.3). */
const OUTLINE_BTN = `h-[30px] border border-hairline-btn bg-transparent px-[14px] font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink hover:border-[rgba(240,232,214,0.5)] ${FOCUS_RING}`;

/**
 * Token ids of the Suits shown on the wall, downscaled to 240px and committed under
 * `public/suits/` (≈15 KB each). Deliberately static files rather than a live `tokenURI` read:
 * the art lives on IPFS behind a public gateway, the originals are 3000px PNGs of 1–4 MB, and
 * the gate is the one screen that has to render instantly for someone who is not yet a member.
 * They are decoration, not data — nothing here claims these are the visitor's, or for sale.
 */
const WALL_TILES = [
  "7", "42", "108", "256", "404", "512", "777", "900", "1024",
  "1200", "1337", "1500", "1800", "2000", "2222", "2500", "2800", "2950",
];

/**
 * One drifting row of Suits. The list is rendered twice and the track translates exactly -50%,
 * so the second copy arrives where the first began and the loop has no seam. Dimming sits on
 * the track rather than each tile, so the hairlines between them stay at full strength and the
 * row reads as one strip of film instead of 36 faded squares.
 */
function Wall({ reverse = false }: { reverse?: boolean }) {
  return (
    <div aria-hidden className="overflow-hidden border-y border-hairline">
      <div
        className={`flex w-max opacity-[0.42] ${reverse ? "animate-wall-back" : "animate-wall"}`}
      >
        {[...WALL_TILES, ...WALL_TILES].map((id, i) => (
          // A plain <img>, not next/image: these are decorative, fixed-size, already 240px and
          // ~15 KB on disk, and the tile shrinks at phone widths — which next/image reads as a
          // one-sided CSS resize and warns about once per tile, 18 times a load. There is no
          // layout shift to guard against either, since the box is sized in CSS both ways.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${id}-${i}`}
            src={`/suits/${id}.jpg`}
            alt=""
            width={240}
            height={240}
            loading="eager"
            decoding="async"
            className="block h-[88px] w-[88px] flex-none border-r border-hairline object-cover tablet:h-[112px] tablet:w-[112px]"
          />
        ))}
      </div>
    </div>
  );
}

interface Content {
  eyebrow: string;
  headline: string;
  sub: string;
  action: ReactNode;
}

/** `idle` and the unreachable `granted` case share this: an invitation to connect. */
function connectContent(openConnectModal?: () => void): Content {
  return {
    eyebrow: "Holders Only",
    headline: "This floor is for Suits.",
    // Non-breaking spaces hold the collection's name together: text-balance evens the two
    // lines, and left alone it will happily break after "The".
    sub: "LongMarkets is open to holders of The Suits NFT. Connect your wallet to check.",
    action: (
      <button type="button" onClick={openConnectModal} className={PRIMARY_BTN}>
        Connect Wallet
      </button>
    ),
  };
}

function getContent(
  access: SuitsAccess,
  ctx: { address?: string; openConnectModal?: () => void; openAccountModal?: () => void },
): Content {
  switch (access.status) {
    case "idle":
      return connectContent(ctx.openConnectModal);
    case "granted":
      // TokenGate renders `children` for "granted" and never mounts LockScreen for it — this
      // branch exists only so the switch stays exhaustive against SuitsAccess's full union.
      return connectContent(ctx.openConnectModal);
    case "checking":
      return {
        eyebrow: "Verifying",
        headline: "Checking the guest list.",
        sub: "Reading the chain for your Suits.",
        action: <Spinner />,
      };
    case "denied":
      return {
        eyebrow: "Not on the List",
        headline: "No Suit on this wallet.",
        // `short()` answers "" for a missing address, which would open the sentence on a bare
        // space. A wallet is always connected to be denied, but the copy should not depend on it.
        sub: ctx.address
          ? `${short(ctx.address)} holds 0 Suits. A Suit is the key to LongMarkets.`
          : "This wallet holds 0 Suits. A Suit is the key to LongMarkets.",
        action: (
          <>
            <a
              href={OPENSEA_URL}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center justify-center ${PRIMARY_BTN}`}
            >
              Get a Suit ↗
            </a>
            <button
              type="button"
              onClick={ctx.openAccountModal}
              className={`mt-[10px] ${OUTLINE_BTN}`}
            >
              Use Another Wallet
            </button>
          </>
        ),
      };
    case "error":
      return {
        eyebrow: "Holders Only",
        headline: "Couldn't reach the chain.",
        sub: "We couldn't read your Suits balance. This is us, not you.",
        action: (
          <button type="button" onClick={access.retry} className={OUTLINE_BTN}>
            Retry
          </button>
        ),
      };
  }
}

/**
 * The whole document for anyone who isn't a Suits holder: one frame, four contents. The frame —
 * mark, wordmark and footnote — never moves; only the eyebrow/headline/sub/action block swaps
 * with `access.status` (spec 2026-09-28-suits-token-gate-design.md §4.3).
 */
export default function LockScreen({
  access,
  address,
}: {
  access: SuitsAccess;
  /** The wallet the balance was read against, handed down by TokenGate so the denial copy can
   *  never name a different one than the check used. */
  address?: Address;
}): ReactElement {
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const content = getContent(access, { address, openConnectModal, openAccountModal });

  const headlineRef = useRef<HTMLHeadingElement>(null);
  const lastStatus = useRef(access.status);
  useEffect(() => {
    if (lastStatus.current === access.status) return;
    lastStatus.current = access.status;
    // Every control lives inside the region that swaps, so a keyboard user who was on
    // CONNECT WALLET when the status changed has just had focus dropped to <body> and their
    // next Tab would restart from the top of the document. Only in that case — focus actually
    // lost, not merely elsewhere, so this never steals it from an open wallet modal — move it
    // to the new headline, which announces the new state and puts Tab back in the right place.
    if (document.activeElement === document.body) headlineRef.current?.focus();
  }, [access.status]);

  return (
    <main className="flex min-h-[100dvh] animate-lock-in flex-col justify-center bg-void">
      {/* Two walls of Suits, drifting in opposite directions, with the copy held between them.
          The gate is the one screen a non-member ever sees, and the thing being asked for is a
          face in a suit — so the room shows its members rather than describing them. Opposite
          directions because two rows travelling together read as one sliding sheet. */}
      <Wall />

      <div className="px-4 py-[56px] tablet:px-5 tablet:py-[76px]">
        <div className="mx-auto w-full max-w-[440px] text-center">
          <SuitsMark size={40} className="mx-auto opacity-90" />
          <div className="mt-[18px] flex items-baseline justify-center gap-2">
            <span className="font-script text-[30px] leading-none text-chalk">SuitVentures</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-50">
              Markets
            </span>
          </div>

          <div aria-live="polite" aria-atomic="true" className="mt-[32px]">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.28em] text-ink-40">
              {content.eyebrow}
            </div>
            {/* The one line that has to carry the screen, so it is given the size to do it —
                well past anything else in the app, which tops out at 22px. */}
            <h1
              ref={headlineRef}
              tabIndex={-1}
              className={`mt-[12px] text-[30px] font-normal leading-[1.12] tracking-[-0.015em] text-ink tablet:text-[40px] ${FOCUS_RING}`}
            >
              {content.headline}
            </h1>
            {/* text-balance, not text-pretty: every sub here runs to two lines, and balancing
                them keeps the break off the middle of a phrase like "Connect your wallet". */}
            <p className="mx-auto mt-[16px] max-w-[380px] text-balance text-[13px] leading-[1.6] text-ink-50">
              {content.sub}
            </p>
            {/* A floor under the action so the footnote below does not hop when a 12px spinner
                is replaced by a 44px button. Denied, with two buttons, is the one state that
                grows past it. */}
            <div className="mx-auto mt-[28px] flex min-h-[44px] max-w-[340px] flex-col items-center justify-center">
              {content.action}
            </div>
          </div>

          <div className="mt-[40px] font-mono text-[9.5px] tracking-[0.14em] text-ink-34">
            3,000 SUITS ·{" "}
            <a
              href={addressUrl(SUITS_COLLECTION_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className={`hover:text-ink-50 ${FOCUS_RING}`}
            >
              {short(SUITS_COLLECTION_ADDRESS)}
            </a>
          </div>
        </div>
      </div>

      <Wall reverse />
    </main>
  );
}
