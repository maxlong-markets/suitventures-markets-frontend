"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { isAddress, type Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useAppState } from "@/context/AppState";
import { useCurrencyConfig, useLaunchSettings, useOpening, useTokenBalanceOf, useTokenDeployed } from "@/hooks/useLaunchpad";
import { useQuotes } from "@/hooks/useMarketsData";
import { robinhoodChain, txUrl } from "@/lib/chain";
import { USDG, ZERO_ADDRESS } from "@/lib/chain/math/constants";
import { fmtAmt, fmtInt, fmtPrice, short } from "@/lib/format";
import {
  LAUNCH_MESSAGES, LaunchExistsError, LaunchFailedError, LaunchRejectedError, LaunchUnconfirmedError, POOL_FEE_PCT, executeLaunch,
  type LaunchStep,
} from "@/lib/launch";
import {
  UPLOAD_REUSE_MS, UploadError, forgetUnsettled, parseUnsettled, readUnsettled, rememberUnsettled, subscribeUnsettled, uploadKey,
  uploadLaunchAssets, type UploadAnswer,
} from "@/lib/launch/client";
import {
  DESCRIPTION_MAX_CHARS, FIELD_LABELS, IMAGE_MAX_BYTES, NAME_MAX_BYTES, SYMBOL_MAX_BYTES, fieldIssues, fieldMessage, onChainText,
  utf8Bytes, validateFields, type LaunchFieldName, type LaunchFields,
} from "@/lib/launch/fields";
import {
  RULE_OF_THUMB, capTokens, estimateFirstBuyTokens, firstBuyCapGross, maxFirstBuy, minFirstBuyTokens, presetValuations, pricePerToken,
  randomSalt, rawToNumber, routerFeeOf, shareOfSupplyPct, usdToRaw,
} from "@/lib/launch/math";
import { toBase, toHuman } from "@/lib/quote/math";
import type { Address } from "@/lib/types";
import CurrencySelect, { hasUsdPrice, orderCurrencies } from "./CurrencySelect";
import { Spinner } from "./ui";

/**
 * `/launch` (instant launchpad design, section 7.2): one transaction that deploys the token, opens its pool at the
 * valuation picked here and optionally buys first. The preview is the contract's own `openingFor`; the fee share, router
 * fee and cap are read live. No line here says or implies that every buyer pays the same price.
 */
type SubmitStep = "sign-in" | "upload" | LaunchStep;
const STEP_LABELS: Record<SubmitStep, string> = {
  "sign-in": "Sign in",
  upload: "Upload",
  approve: "Approve",
  sign: "Sign the payment",
  confirm: "Confirm in wallet",
  launching: "Launching",
};
const AMOUNT_RE = /^\d*\.?\d*$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const LABEL = "flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-45";
const INPUT = "mt-2 h-10 w-full border border-hairline-strong bg-transparent px-3 text-[13px] outline-none focus:border-hairline-focus";
const PRIMARY = "mt-[14px] h-11 w-full bg-chalk font-mono text-[11px] uppercase tracking-[0.22em] text-onlight hover:bg-white";
const DISABLED =
  "mt-[14px] h-11 w-full cursor-not-allowed border border-hairline-mid bg-[rgba(244,238,218,0.06)] font-mono text-[11px] uppercase tracking-[0.22em] text-ink-34";
const PENDING =
  "mt-[14px] flex h-11 w-full cursor-wait items-center justify-center gap-[10px] bg-[rgba(244,238,218,0.55)] font-mono text-[11px] uppercase tracking-[0.22em] text-onlight";
/** TokenView's transaction link recipe, with room to tap. */
const LINK = "inline-block py-[6px] font-mono text-[10px] uppercase tracking-[0.2em] text-ink-60 hover:text-ink";
/** A text control that reads as a link (UX review 3), in the label row's type. */
const TEXT_LINK = "py-1 font-mono text-[11px] normal-case tracking-[0.04em] text-ink-70 underline underline-offset-2 hover:text-ink";

/**
 * A percentage with up to four decimals and no trailing zeros (70, 70.5, 0.7, 0.705), joined to its sign by a no-break
 * space, so a number never ends one line with its "%" starting the next (fix round 1, ruling 10).
 */
const pct = (n: number) => `${Number(n.toFixed(4))}\u{A0}%`;
/** The same join for a percentage the code already formats. */
const PCT = "\u{A0}%";
/** The rule of thumb lives in math.ts with plain spaces; shown here, each number keeps its percent sign. */
const RULE_OF_THUMB_SHOWN = RULE_OF_THUMB.replace(/(\d) %/g, `$1${PCT}`);
/** Shown under the preview when the contract opened below the pick (UX review 5). */
const ROUNDED_NOTE = `Rounded down to the pool's nearest price step, at most about 2${PCT} below your pick.`;
/** The locked card once the token turns up at its predicted address. */
const WENT_THROUGH = "It went through: your token is live.";

/**
 * Why the form stays locked with no redirect (UX review B3, fix round 1):
 * - "unsettled": the launch was sent, or may have been, and its outcome is not known. Pressing Launch again would reuse the
 *   salt, and an edited name would predict an empty address, so a second coin could launch. Only "Start a new launch" or
 *   the token turning up ends it, and it is remembered for this tab, so a reload shows the same card.
 * - "live": the token was already live at the predicted address before anything was sent.
 */
type Lock = { why: "unsettled"; token: Address; hash?: Hex } | { why: "live"; token: Address };
/** The first reason the launch cannot go ahead; `answered` marks the two the button itself answers (UX review 8). */
type Blocker = { text: string; answered?: true };
/**
 * The one submit button's look and what a press does, in each state; one element throughout, so keyboard focus never drops.
 * Plain data: the press is dispatched from the JSX handler, so nothing here runs during render.
 */
type ButtonState = {
  label: string; className: string; spinner: boolean; ariaDisabled: boolean; disabled: boolean;
  action: "launch" | "connect" | "switch" | "none";
};

/** A typed amount in raw units, 0 for a half-typed or empty field. Display and gating only. */
function parseAmount(text: string, decimals: number): bigint {
  if (text === "" || text === ".") return 0n;
  try {
    return toBase(text, decimals);
  } catch {
    return 0n;
  }
}

/**
 * usdToRaw does not clamp: a USD amount typed at the currency's maximum can round to one raw unit above it, and is
 * brought back down to the maximum here. Anything further out stays out of range; null (it rounded to zero) stays null.
 */
function clampConverted(raw: bigint | null, max: bigint | undefined): bigint | null {
  if (raw === null || max === undefined) return raw;
  return raw > max && raw - max <= 1n ? max : raw;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-ink-50">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

/**
 * A field's own message, in the image note's recipe, right under the field (UX review 6). The region is always there and
 * polite, and only its text changes (fix round 1, ruling 8): a message that appears while typing is announced, and a
 * keystroke that leaves the same message leaves the same text, so nothing is announced again. Empty, it takes no room.
 */
function FieldNote({ id, text }: { id: string; text: string | null }) {
  return (
    <div id={id} aria-live="polite" className={text ? "mt-2 font-mono text-[10.5px] leading-[1.5] text-down" : undefined}>
      {text}
    </div>
  );
}

/** A counter in the label row, in the down colour while over its limit. */
const counterClass = (over: boolean) => `normal-case tracking-[0.04em]${over ? " text-down" : ""}`;

export default function LaunchForm() {
  const router = useRouter();
  const { address, isConnected, signed, withSignIn, dropSession, addToast, updateToast } = useAppState();
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { data: walletClient } = useWalletClient({ chainId: robinhoodChain.id });
  // On another network wagmi gives no wallet client for Robinhood Chain; the button asks the wallet to switch instead.
  const { chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const quotesQuery = useQuotes();
  const currencies = useMemo(() => orderCurrencies(quotesQuery.data ?? []), [quotesQuery.data]);

  const [image, setImage] = useState<File | null>(null);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [picked, setPicked] = useState<Address | null>(null);
  const [preset, setPreset] = useState<number | "custom">(0);
  const [custom, setCustom] = useState("");
  const [firstBuy, setFirstBuy] = useState("");
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payout, setPayout] = useState("");
  const [salt, setSalt] = useState<Hex>(() => randomSalt());
  const [pending, setPending] = useState(false);
  const [plan, setPlan] = useState<SubmitStep[]>([]);
  const [current, setCurrent] = useState<SubmitStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the launch is confirmed: the form stays locked until the token page opens, so no enabled Launch flashes.
  const [done, setDone] = useState(false);
  const [lock, setLock] = useState<Lock | null>(null);
  // A switch the wallet refused or could not make, tied to the network it was asked from.
  const [switchNote, setSwitchNote] = useState<{ from: number; text: string } | null>(null);
  const inFlight = useRef(false);
  const resumeAfterSignIn = useRef(false);
  const uploadCache = useRef<{ key: string; answer: UploadAnswer; at: number } | null>(null);

  // A launch whose outcome is not known, remembered for this tab (fix round 1, ruling 6). The server snapshot is "none", so
  // hydration matches, and the client then reads the tab's storage; a storage that refuses reads as none.
  const storedRaw = useSyncExternalStore(subscribeUnsettled, readUnsettled, () => null);
  const stored = useMemo(() => parseUnsettled(storedRaw), [storedRaw]);
  const held: Lock | null =
    lock ?? (stored && address && stored.wallet === address.toLowerCase() ? { why: "unsettled", token: stored.token, hash: stored.hash } : null);
  // The other way out besides "Start a new launch": the token turning up at its predicted address.
  const found = useTokenDeployed(held?.why === "unsettled" ? held.token : undefined, held?.why === "unsettled");
  const disconnected = !isConnected || !address;

  // The currency: USDG until the creator picks another.
  const asset = currencies.find((q) => q.address.toLowerCase() === (picked ?? USDG).toLowerCase()) ?? currencies[0];
  const quote = asset?.address;
  const decimals = asset?.decimals ?? 18;
  const usd = asset && hasUsdPrice(asset) ? asset.usdPrice : null;

  const settings = useLaunchSettings(address);
  const bounds = useCurrencyConfig(quote);
  // A max of 0 means the owner has not set this currency up on the launchpad: no presets, and the button says so.
  const closedCurrency = bounds !== undefined && bounds.max === 0n;
  const presets = bounds && !closedCurrency ? presetValuations(bounds.min, bounds.max) : [];
  const requested: bigint | null =
    preset === "custom"
      ? usd !== null
        ? clampConverted(usdToRaw(custom, usd, decimals), bounds?.max)
        : custom === "" ? null : parseAmount(custom, decimals) || null
      : (presets[preset] ?? null);
  const inRange = requested !== null && bounds !== undefined && requested >= bounds.min && requested <= bounds.max;
  // What goes on chain (UX review 7): the preview predicts the token for exactly these, and the launch sends the same.
  const nameOnChain = onChainText(name);
  const symbolOnChain = onChainText(symbol);
  const opening = useOpening({ account: address, salt, name: nameOnChain, symbol: symbolOnChain, quote, valuation: inRange ? requested : null });
  const snapped = inRange ? opening.snapped : undefined;
  const balance = useTokenBalanceOf(quote, address);

  // Never a default for a setting: until the contract has answered, the button says so (no silent 0 bps or 0 % cap).
  const routerFeeBps = settings.routerFeeBps;
  const capBps = settings.firstBuyCapBps;
  const settingsRead =
    routerFeeBps !== undefined &&
    capBps !== undefined &&
    settings.creatorShareBps !== undefined &&
    settings.hook !== undefined &&
    settings.launchesToday !== undefined &&
    settings.dailyLimit !== undefined;
  const hookSet = settings.hook !== undefined && settings.hook.toLowerCase() !== ZERO_ADDRESS;
  const creationFee = bounds?.creationFee ?? 0n;
  const firstBuyRaw = parseAmount(firstBuy, decimals);
  const total = firstBuyRaw + creationFee;
  const estimate = snapped && routerFeeBps !== undefined ? estimateFirstBuyTokens(firstBuyRaw, snapped, routerFeeBps) : 0n;
  const capGross = snapped && routerFeeBps !== undefined && capBps !== undefined ? firstBuyCapGross(snapped, capBps, routerFeeBps) : null;
  const maxBuy = maxFirstBuy(balance, creationFee, capGross);
  const rawFields: LaunchFields = { name, symbol, description, website, x, telegram };
  // One set of rules with the upload route (fields.ts): the stored fields when all pass, and each field's own issue.
  const checked = validateFields(rawFields);
  const issues = fieldIssues(rawFields);
  /**
   * A field's message shows while its value breaks a rule, not on leaving the field: a message that appeared on blur
   * pushed what sits below it down between pointerdown and click, so the click missed. An empty field says nothing: the
   * button's reason asks for the name and symbol, and the links are optional.
   */
  const noteFor = (field: LaunchFieldName): string | null => {
    const issue = issues[field];
    return issue !== undefined && rawFields[field] !== "" ? fieldMessage(field, issue) : null;
  };
  const payoutAddress = (payoutOpen && payout !== "" ? payout : address) as Address | undefined;
  // Fix round 1, ruling 12: the contract pays a zero payout's fees to the creator instead, so it is refused, not shown.
  let payoutProblem: string | null = null;
  if (payoutOpen && payout !== "") {
    if (!isAddress(payout)) payoutProblem = "That is not a valid address. Check it for typos.";
    else if (payout.toLowerCase() === ZERO_ADDRESS) payoutProblem = "The zero address cannot be the payout. Leave the field empty to use this wallet.";
  }
  const wrongNetwork = chainId !== undefined && chainId !== robinhoodChain.id;

  /** Whole dollars when the currency has a USD price, else the currency's own units. */
  const money = (raw: bigint) => {
    const n = rawToNumber(raw, decimals);
    return usd !== null ? `$${fmtInt(n * usd)}` : `${fmtAmt(n)} ${asset?.symbol ?? ""}`;
  };
  const units = (raw: bigint) => `${fmtAmt(rawToNumber(raw, decimals))} ${asset?.symbol ?? ""}`;
  const perToken = (raw: bigint) => {
    const p = pricePerToken(raw, decimals) * (usd ?? 1);
    // Below $0.0001 fmtPrice's 8 decimals would print $0.00000500; four significant digits, never exponent notation,
    // print a launch's typical opening price as $0.000004995.
    const text = p >= 0.0001 || p <= 0 ? fmtPrice(p).slice(1) : p.toFixed(Math.min(20, 3 - Math.floor(Math.log10(p))));
    return usd !== null ? `$${text}` : `${text} ${asset?.symbol ?? ""}`;
  };

  /** The first reason the launch cannot go ahead, first match wins; the button answers the two marked `answered` itself. */
  function blockerOf(): Blocker | null {
    if (disconnected) return { text: "Connect a wallet to launch.", answered: true };
    if (settings.allowed === undefined) return { text: "Checking your wallet." };
    if (!settings.allowed) return { text: "Launching is open to Suits holders." };
    if (!settingsRead) return { text: "Reading the launchpad's settings." };
    // The contracts README promises it: no launch through the app while a hook is set on the launchpad.
    if (hookSet) return { text: "Launches are paused while a hook is set." };
    if (settings.launchesToday !== undefined && settings.dailyLimit !== undefined && settings.launchesToday >= settings.dailyLimit) {
      return { text: "You have used today's launches." };
    }
    if (!image || nameOnChain === "" || symbolOnChain === "") return { text: "Add an image, a name and a symbol." };
    // The field says what to change under itself; this points at the first one in form order.
    if (!checked.ok) return { text: `Check the ${FIELD_LABELS[checked.field]}.` };
    if (!bounds) return { text: "Reading this currency's limits." };
    if (closedCurrency) return { text: "This currency is not open for launches." };
    if (!inRange) return { text: `Pick a valuation between ${money(bounds.min)} and ${money(bounds.max)}.` };
    if (balance !== undefined && total > balance) return { text: "The first buy is more than your balance." };
    if (firstBuyRaw > 0n && capBps !== undefined && estimate > capTokens(capBps)) return { text: "The first buy is above the cap." };
    if (payoutProblem !== null) return { text: "Check the payout address." };
    if (wrongNetwork) return { text: "Switch your wallet to Robinhood Chain.", answered: true };
    if (!walletClient || !publicClient) return { text: "Connecting to your wallet." };
    // The opening read lags the valuation by a 300 ms debounce; a click in that window would use the old snapped value.
    if (!snapped || opening.pending) return { text: "Working out the opening price." };
    return null;
  }
  const blocker = blockerOf();
  const reason = blocker?.text ?? null;

  const onImage = (file: File | null) => {
    setImageNote(null);
    if (preview && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(preview);
    setPreview(null);
    setImage(null);
    if (!file) return;
    // A courtesy only: the route re-checks the bytes themselves (spec 6 step 7).
    if (!IMAGE_TYPES.includes(file.type)) return setImageNote("Use a PNG, JPEG, WebP or GIF.");
    if (file.size > IMAGE_MAX_BYTES) return setImageNote("The image is larger than 2 MB.");
    setImage(file);
    if (typeof URL.createObjectURL === "function") setPreview(URL.createObjectURL(file));
  };

  /**
   * Step 2: the answer is kept for this image, these fields and this wallet, refreshed after 12 hours (spec 7.2). `now`
   * comes from the click (or the resume effect), never read here: the component body stays free of clock reads.
   */
  async function uploadOnce(fields: LaunchFields, file: File, wallet: Address, now: number): Promise<UploadAnswer> {
    const key = uploadKey(fields, file, wallet);
    const cached = uploadCache.current;
    if (cached && cached.key === key && now - cached.at < UPLOAD_REUSE_MS) return cached.answer;
    const answer = await uploadLaunchAssets(fields, file);
    uploadCache.current = { key, answer, at: now };
    return answer;
  }

  const submit = async (now: number) => {
    // A launch in flight, a confirmed or locked one, or one already waiting for its signature: nothing more to queue.
    if (inFlight.current || done || held !== null || resumeAfterSignIn.current) return;
    // The predicted token is taken here, from the settled preview: the wallet code checks it for code before sending.
    const token = opening.token;
    if (
      reason !== null || !checked.ok || !address || !walletClient || !publicClient || !quote || !image || !snapped ||
      requested === null || !payoutAddress || !token
    ) {
      // A resumed submit that can no longer go ahead leaves no step spinning.
      setPlan([]);
      setCurrent(null);
      return;
    }
    // "Approve" joins the list only when the wallet code reports it (the allowance was short), so no step is ticked that never ran.
    const walletSteps: SubmitStep[] = ["upload", ...(total > 0n ? (["sign"] as const) : []), "confirm", "launching"];
    const onStep = (step: LaunchStep) => {
      if (step === "approve") {
        setPlan((p) => {
          if (p.includes("approve")) return p;
          const at = p.indexOf("sign");
          return at < 0 ? p : [...p.slice(0, at), "approve", ...p.slice(at)];
        });
      }
      setCurrent(step);
    };
    setError(null);
    if (!signed) {
      // Step 1: the existing SignModal through AppState's gate. The effect below resumes once `signed` flips.
      setPlan(["sign-in", ...walletSteps]);
      setCurrent("sign-in");
      resumeAfterSignIn.current = true;
      // Closed without signing: drop the queued launch and the step list, so nothing resumes on a later, unrelated sign-in.
      withSignIn("launch", () => {}, () => {
        // Too late to drop: the launch already started once the signature landed.
        if (inFlight.current) return;
        resumeAfterSignIn.current = false;
        setCurrent(null);
        setPlan([]);
      });
      return;
    }
    inFlight.current = true;
    setPending(true);
    setPlan((p) => (p[0] === "sign-in" ? ["sign-in", ...walletSteps] : walletSteps));
    let toastId: number | null = null;
    let hash: Hex | undefined;
    // The fields as the route stores them: the name and symbol trimmed, as the preview predicted them, and links normalised.
    const fields = checked.fields;
    try {
      setCurrent("upload");
      const answer = await uploadOnce(fields, image, address, now);
      const handle = await executeLaunch(
        {
          name: fields.name, symbol: fields.symbol, metadataUri: answer.metadataUri, quote, valuation: requested, firstBuy: firstBuyRaw,
          minFirstBuyTokens: firstBuyRaw > 0n ? minFirstBuyTokens(estimate) : 0n, payout: payoutAddress, salt, creationFee, token,
        },
        { wallet: walletClient, publicClient, account: address },
        onStep,
      );
      hash = handle.hash;
      toastId = addToast({ kind: "pending", message: `Launching ${fields.symbol}`, hash: handle.hash });
      const confirmed = await handle.confirmation;
      updateToast(toastId, { kind: "confirmed", message: `Launched ${fields.symbol}` });
      setDone(true);
      router.push(`/t/${confirmed.token}?launched=${handle.hash}`);
    } catch (err) {
      const known =
        err instanceof UploadError || err instanceof LaunchFailedError || err instanceof LaunchRejectedError ||
        err instanceof LaunchUnconfirmedError || err instanceof LaunchExistsError;
      const message = known ? (err as Error).message : LAUNCH_MESSAGES.launchFallback;
      // The cookie is gone while memory still says signed (UX review B2): forget the session, so the next press of Launch
      // takes the sign-in step and resumes by itself, instead of uploading into the same 401 again. Only this wallet's
      // session: another wallet may have signed in meanwhile (fix round 1, ruling 7).
      if (err instanceof UploadError && err.code === "not-signed-in") dropSession(address);
      // Someone initialised this token's pool key first (spec 4.10): a new salt is a new address and a new key.
      if (err instanceof LaunchFailedError && err.revert === "PoolAlreadyInitialized") setSalt(randomSalt());
      // The owner changed this currency's creation fee under the open form: re-read it before the creator reviews.
      if (err instanceof LaunchFailedError && err.revert === "PermitMismatch") bounds?.refetch();
      // It may have landed, or it did: the form stays locked and links the transaction and the token page (UX review B3),
      // and this tab remembers it, so a reload shows the same card (fix round 1, ruling 6).
      if (err instanceof LaunchUnconfirmedError) {
        setLock({ why: "unsettled", token, hash });
        rememberUnsettled({ wallet: address, token, hash, at: now });
      } else if (err instanceof LaunchExistsError) setLock({ why: "live", token: err.token });
      else setError(message);
      if (toastId !== null) updateToast(toastId, { kind: err instanceof LaunchUnconfirmedError ? "unconfirmed" : "failed", message });
    } finally {
      inFlight.current = false;
      setPending(false);
      setCurrent(null);
    }
  };

  // The submit closes over this render's state, so the resume after sign-in must call the newest one.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    if (signed && resumeAfterSignIn.current) {
      resumeAfterSignIn.current = false;
      void submitRef.current(Date.now());
    }
  }, [signed]);

  const busy = pending || done;
  // Counted as they go on chain: trimmed.
  const nameBytes = utf8Bytes(nameOnChain);
  const symbolBytes = utf8Bytes(symbolOnChain);
  const descriptionChars = [...description].length;
  /** A field's accessible wiring to its own message: invalid while the message shows, described by it. */
  const described = (field: LaunchFieldName) => {
    const note = noteFor(field);
    return { "aria-invalid": note !== null, "aria-describedby": note !== null ? `launch-${field}-note` : undefined };
  };
  const onAmount = (setter: (v: string) => void) => (raw: string) => {
    if (AMOUNT_RE.test(raw)) setter(raw);
  };

  // UX review 8: with no wallet the button opens the connect modal; on another network it asks the wallet to switch.
  const onSwitch = () => {
    const from = chainId;
    setSwitchNote(null);
    switchChain(
      { chainId: robinhoodChain.id },
      {
        onError: () => {
          if (from !== undefined) setSwitchNote({ from, text: "The wallet did not switch. Pick Robinhood Chain in your wallet." });
        },
      },
    );
  };
  /**
   * The locked card's way out (fix round 1, ruling 6): forgets the remembered launch and draws a new salt, so the next
   * launch predicts, and deploys to, a new address. The other way out is the token turning up.
   */
  const startOver = () => {
    forgetUnsettled();
    setLock(null);
    setError(null);
    setSalt(randomSalt());
  };
  // While busy or locked a press still goes to submit, whose guard ignores it (the button is only aria-disabled then).
  // The action comes from state flags, never from the wording of a reason (fix round 1, ruling 13).
  let button: ButtonState;
  if (busy) {
    const label = done ? "Launched" : current ? STEP_LABELS[current] : "Launch";
    button = { label, className: PENDING, spinner: true, ariaDisabled: true, disabled: false, action: "launch" };
  } else if (held) {
    const label = held.why === "live" ? "Already live" : found ? "Launched" : "Sent";
    button = { label, className: DISABLED, spinner: false, ariaDisabled: true, disabled: false, action: "launch" };
  } else if (disconnected) {
    button = { label: "Connect wallet", className: PRIMARY, spinner: false, ariaDisabled: false, disabled: false, action: "connect" };
  } else if (wrongNetwork) {
    button = switching
      ? { label: "Confirm in wallet", className: PENDING, spinner: true, ariaDisabled: true, disabled: false, action: "none" }
      : { label: "Switch to Robinhood Chain", className: PRIMARY, spinner: false, ariaDisabled: false, disabled: false, action: "switch" };
  } else {
    const blocked = reason !== null;
    button = { label: "Launch", className: blocked ? DISABLED : PRIMARY, spinner: false, ariaDisabled: blocked, disabled: blocked, action: "launch" };
  }
  // The button itself answers "connect" and "switch"; any other reason shows under it.
  const statusLine = busy || held || blocker?.answered ? "" : (reason ?? "");
  // The locked card's line: what is known about the launch.
  let heldText = "";
  if (held?.why === "live") heldText = LAUNCH_MESSAGES.alreadyLive;
  else if (held && found) heldText = WENT_THROUGH;
  else if (held) heldText = held.hash ? LAUNCH_MESSAGES.unconfirmed : LAUNCH_MESSAGES.maybeSent;
  const heldHash = held?.why === "unsettled" ? held.hash : undefined;

  // The preview and the reason it is blank (UX review 18) share one slot of one height (see the markup), so nothing below
  // the valuation moves while the price is read (fix round 1, ruling 3).
  const previewText = snapped ? `Opens at ${money(snapped)} · ${perToken(snapped)} per token` : "";
  let hintText = "";
  if (!snapped && inRange) {
    if (nameOnChain === "" || symbolOnChain === "") hintText = "Enter a name and symbol to see the opening price.";
    else if (!address) hintText = "Connect a wallet to see the opening price.";
    else if (opening.pending) hintText = "Working out the opening price…";
  }
  // UX review 5: the contract opens at or below the pick, within one 1.0001^200 step of it (about 2 %).
  const roundedDown = snapped !== undefined && requested !== null && !opening.pending && snapped !== requested;

  // UX review 4: the cap is on tokens received; the cost is the gross first buy that reaches it at this opening.
  let capLine: string | null = null;
  if (capBps === 0) capLine = "First buys are closed for now.";
  else if (capBps !== undefined && capBps < 10_000) {
    const cost = capGross !== null && snapped ? `, about ${money(capGross)} at this valuation` : "";
    capLine = `Up to ${pct(capBps / 100)} of the supply${cost}.`;
  }

  // The owner's ruling of 30 Sep 2026: the pool fee is one number here, with no split. The no-break space keeps the
  // number with its percent sign.
  const feeLine = `Every trade of ${symbolOnChain || "your token"} pays a ${pct(POOL_FEE_PCT)} pool fee. Collect your fees on the token's page.`;

  // UX review 3: where the fees go, always echoed back; the payout can only be changed later by the payout address itself.
  const payoutIsWallet = payoutAddress !== undefined && address !== undefined && payoutAddress.toLowerCase() === address.toLowerCase();
  const payoutText = payoutAddress ? `${short(payoutAddress)}${payoutIsWallet ? " (this wallet)" : ""}` : "Your wallet";

  return (
    <div className="mt-5 flex flex-col gap-6 twocol:flex-row twocol:items-start twocol:gap-8">
      <div className="w-full min-w-0 flex-1">
        <label className={LABEL} htmlFor="launch-image">
          <span>Image</span>
          <span className="normal-case tracking-[0.04em]">PNG, JPEG, WebP or GIF, 2 MB at most</span>
        </label>
        <div className="mt-2 flex min-w-0 items-center gap-4">
          <div className="flex h-24 w-24 flex-none items-center justify-center border border-hairline-strong">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL of the picked file, nothing to optimise
              <img src={preview} alt="" width={96} height={96} className="h-24 w-24 object-cover" />
            ) : (
              <span className="font-mono text-[10px] text-ink-40">96 × 96</span>
            )}
          </div>
          <input id="launch-image" type="file" accept={IMAGE_TYPES.join(",")} aria-label="Image" onChange={(e) => onImage(e.target.files?.[0] ?? null)} className="min-w-0 flex-1 text-[12px]" />
        </div>
        {imageNote ? <div className="mt-2 font-mono text-[10.5px] text-down">{imageNote}</div> : null}

        <label className={`${LABEL} mt-5`} htmlFor="launch-name">
          <span>Name</span>
          <span className={counterClass(nameBytes > NAME_MAX_BYTES)}>{nameBytes}/{NAME_MAX_BYTES} bytes</span>
        </label>
        <input id="launch-name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} {...described("name")} className={INPUT} autoComplete="off" />
        <FieldNote id="launch-name-note" text={noteFor("name")} />

        <label className={`${LABEL} mt-4`} htmlFor="launch-symbol">
          <span>Symbol</span>
          <span className={counterClass(symbolBytes > SYMBOL_MAX_BYTES)}>{symbolBytes}/{SYMBOL_MAX_BYTES} bytes</span>
        </label>
        <input id="launch-symbol" aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} {...described("symbol")} className={INPUT} autoComplete="off" />
        <FieldNote id="launch-symbol-note" text={noteFor("symbol")} />

        <label className={`${LABEL} mt-4`} htmlFor="launch-description">
          <span>Description</span>
          <span className={counterClass(descriptionChars > DESCRIPTION_MAX_CHARS)}>{descriptionChars}/{DESCRIPTION_MAX_CHARS}</span>
        </label>
        <textarea
          id="launch-description"
          aria-label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          {...described("description")}
          rows={3}
          className="mt-2 w-full border border-hairline-strong bg-transparent px-3 py-2 text-[13px] outline-none focus:border-hairline-focus"
        />
        <FieldNote id="launch-description-note" text={noteFor("description")} />

        {(
          [
            ["website", "Website", website, setWebsite, "https://"],
            ["x", "X", x, setX, "handle or x.com link"],
            ["telegram", "Telegram", telegram, setTelegram, "name or t.me link"],
          ] as const
        ).map(([field, label, value, setter, hint]) => (
          <div key={label}>
            <label className={`${LABEL} mt-4`} htmlFor={`launch-${label}`}>
              <span>{label}</span>
              <span className="normal-case tracking-[0.04em]">optional</span>
            </label>
            {/* A phone must not capitalise, correct or spell-check a link (fix round 1, ruling 4). */}
            <input
              id={`launch-${label}`}
              aria-label={label}
              value={value}
              placeholder={hint}
              onChange={(e) => setter(e.target.value)}
              {...described(field)}
              className={INPUT}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode={field === "website" ? "url" : undefined}
            />
            <FieldNote id={`launch-${field}-note`} text={noteFor(field)} />
          </div>
        ))}

        <div className={`${LABEL} mt-5`}>
          <span>Currency</span>
        </div>
        <CurrencySelect
          quotes={currencies}
          value={quote ?? null}
          onChange={(a) => {
            setPicked(a);
            setPreset(0);
            setCustom("");
            setFirstBuy("");
          }}
        />

        <div className={`${LABEL} mt-5`}>
          <span>Opening valuation</span>
          {bounds && !closedCurrency ? <span className="normal-case tracking-[0.04em]">{money(bounds.min)} to {money(bounds.max)}</span> : null}
        </div>
        {/* One equal column per cell, each allowed to shrink: five cells fit a 360 px phone even with a currency's own units. */}
        <div
          role="group"
          aria-label="Opening valuation"
          className="mt-2 grid border border-hairline-strong"
          style={{ gridTemplateColumns: `repeat(${presets.length + 1}, minmax(0, 1fr))` }}
        >
          {presets.map((v, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={preset === i}
              onClick={() => setPreset(i)}
              className={`h-7 min-w-0 truncate whitespace-nowrap border-r border-hairline-mid px-1 font-mono text-[10.5px] ${preset === i ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-60"}`}
            >
              {money(v)}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={preset === "custom"}
            onClick={() => setPreset("custom")}
            className={`h-7 min-w-0 truncate px-1 font-mono text-[10.5px] ${preset === "custom" ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-60"}`}
          >
            Custom
          </button>
        </div>
        {preset === "custom" ? (
          <div className="mt-2 flex h-10 items-center border border-hairline-strong focus-within:border-hairline-focus">
            <input
              aria-label="Custom valuation"
              inputMode="decimal"
              autoComplete="off"
              value={custom}
              onChange={(e) => onAmount(setCustom)(e.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] tabular-nums outline-none"
            />
            <span className="pr-3 font-mono text-[11px] text-ink-45">{usd !== null ? "USD" : asset?.symbol}</span>
          </div>
        ) : null}
        {/*
          The preview keeps one height in every state (no name yet, reading, read, rounded down or not), so First buy, Max and
          the payout link never move under a tap while the price is read (fix round 1, ruling 3). Two layers share one grid
          cell: the preview (one line, then the rounding note) is always laid out and only hidden, and the hint sits over it.
        */}
        <div className="mt-2 grid font-mono" aria-live="polite">
          <div className={`col-start-1 row-start-1${snapped ? "" : " invisible"}`} aria-hidden={!snapped}>
            <div className={`truncate text-[11px] leading-[1.5] ${opening.pending ? "text-ink-40" : "text-ink-60"}`} title={previewText || undefined}>
              {previewText || "\u{A0}"}
            </div>
            <div className={`mt-1 text-[10.5px] leading-[1.5] text-ink-45${roundedDown ? "" : " invisible"}`} aria-hidden={!roundedDown}>
              {ROUNDED_NOTE}
            </div>
          </div>
          <div className={`col-start-1 row-start-1 text-[11px] leading-[1.5] text-ink-60${snapped ? " invisible" : ""}`} aria-hidden={Boolean(snapped)}>
            {hintText}
          </div>
        </div>

        <label className={`${LABEL} mt-5`} htmlFor="launch-first-buy">
          <span>First buy</span>
          <span className="normal-case tracking-[0.04em]">Balance {balance !== undefined ? units(balance) : "—"}</span>
        </label>
        <div className="mt-2 flex h-10 items-center border border-hairline-strong focus-within:border-hairline-focus">
          <input
            id="launch-first-buy"
            aria-label="First buy"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={firstBuy}
            onChange={(e) => onAmount(setFirstBuy)(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] tabular-nums outline-none"
          />
          <button
            type="button"
            disabled={maxBuy === null}
            onClick={() => maxBuy !== null && setFirstBuy(toHuman(maxBuy, decimals))}
            className="mr-2 h-7 border border-hairline-mid bg-transparent px-[10px] font-mono text-[10.5px] text-ink-70 hover:border-hairline-hover hover:text-ink"
          >
            Max
          </button>
          <span className="pr-3 font-mono text-[11px] text-ink-45">{asset?.symbol}</span>
        </div>
        {/*
          Fix round 1, ruling 3: the cap line holds two lines, the most its sentence takes at 320 px, while its cost is read
          again; the estimate stays in place, hidden, while the price is read. Nothing below them moves under a tap.
        */}
        <div className="mt-2 min-h-[3em] font-mono text-[10.5px] leading-[1.5] text-ink-45">{capLine ?? ""}</div>
        {firstBuyRaw > 0n ? (
          <div className={`mt-1 min-h-[1.5em] font-mono text-[10.5px] leading-[1.5] text-ink-60${snapped ? "" : " invisible"}`} aria-hidden={!snapped}>
            {snapped ? `About ${fmtAmt(rawToNumber(estimate, 18), 0)} tokens, ${shareOfSupplyPct(estimate).toFixed(2)}${PCT} of supply` : "\u{A0}"}
          </div>
        ) : null}

        <div className={`${LABEL} mt-5`}>
          <span>Fee payout</span>
          <button
            type="button"
            onClick={() => setPayoutOpen((o) => !o)}
            aria-expanded={payoutOpen}
            aria-controls={payoutOpen ? "launch-payout" : undefined}
            className={TEXT_LINK}
          >
            {payoutOpen ? "Use this wallet" : "Pay another address"}
          </button>
        </div>
        {payoutOpen ? (
          <>
            <input
              id="launch-payout"
              aria-label="Payout address"
              placeholder="Leave empty to use this wallet"
              value={payout}
              onChange={(e) => setPayout(e.target.value.trim())}
              aria-invalid={payoutProblem !== null}
              aria-describedby={payoutProblem !== null ? "launch-payout-note" : undefined}
              className={INPUT}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <FieldNote id="launch-payout-note" text={payoutProblem} />
          </>
        ) : null}
      </div>

      <div className="w-full flex-none twocol:w-[360px]">
        <div className="border border-hairline p-4 font-mono text-[11.5px]">
          <Row label="Opening valuation">{snapped ? money(snapped) : "—"}</Row>
          <Row label="Opening price">{snapped ? perToken(snapped) : "—"}</Row>
          <Row label="First buy">{firstBuyRaw > 0n ? units(firstBuyRaw) : "None"}</Row>
          {firstBuyRaw > 0n && routerFeeBps !== undefined ? (
            <div className="pb-1 text-right text-[10.5px] text-ink-45">
              of which router fee {units(routerFeeOf(firstBuyRaw, routerFeeBps))} at {(routerFeeBps / 100).toFixed(2)}
              {PCT}
            </div>
          ) : null}
          <Row label="Creation fee">{creationFee === 0n ? "Free" : units(creationFee)}</Row>
          <Row label="You pay">{total === 0n ? "Gas only" : units(total)}</Row>
          <Row label="Fee payout">{payoutProblem !== null ? <span className="text-down">Not a valid address</span> : payoutText}</Row>
          <div className="mt-3 border-t border-hairline-soft pt-3 text-[11px] leading-[1.5] text-ink-60">
            {feeLine ? <div>{feeLine}</div> : null}
            {settings.dailyLimit !== undefined && settings.launchesToday !== undefined ? (
              <div className="mt-1">{`${Math.max(0, settings.dailyLimit - settings.launchesToday)} of ${settings.dailyLimit} left today. The count resets at 00:00 UTC.`}</div>
            ) : null}
            <div className="mt-1">{RULE_OF_THUMB_SHOWN}</div>
          </div>

          {/*
            One button for every state, so keyboard focus stays on it: while a launch runs or has landed it is only
            aria-disabled (a disabled button drops focus) and names the current step; the click guard does the rest.
          */}
          <button
            type="button"
            disabled={button.disabled}
            aria-disabled={button.ariaDisabled}
            onClick={() => {
              if (button.action === "connect") openConnectModal?.();
              else if (button.action === "switch") onSwitch();
              else if (button.action === "launch") void submit(Date.now());
            }}
            className={button.className}
          >
            {button.spinner ? <Spinner dark /> : null}
            {button.label}
          </button>
          <div role="status" aria-live="polite" className="mt-2 text-center text-[10.5px] text-ink-50 empty:hidden">
            {statusLine}
          </div>
          {held ? (
            <>
              <div role="alert" className="mt-2 text-center text-[10.5px] leading-[1.5] text-ink-70">
                {heldText}
              </div>
              <div className="mt-1 flex flex-wrap justify-center gap-x-5">
                {heldHash ? (
                  <a href={txUrl(heldHash)} target="_blank" rel="noreferrer" className={LINK}>
                    View the transaction ↗
                  </a>
                ) : null}
                <Link href={`/t/${held.token.toLowerCase()}${heldHash ? `?launched=${heldHash}` : ""}`} className={LINK}>
                  Open the token page
                </Link>
              </div>
              <div className="mt-1 text-center">
                <button type="button" onClick={startOver} className={TEXT_LINK}>
                  Start a new launch
                </button>
              </div>
            </>
          ) : error ? (
            <div role="alert" className="mt-2 text-center text-[10.5px] text-down">
              {error}
            </div>
          ) : null}
          {wrongNetwork && switchNote !== null && switchNote.from === chainId ? (
            <div role="alert" className="mt-2 text-center text-[10.5px] text-down">
              {switchNote.text}
            </div>
          ) : null}
          <div role="status" aria-live="polite" aria-label="Launch steps">
            {current !== null && plan.length > 0 ? (
              <ol className="mt-3 space-y-1 text-[10.5px]">
                {plan.map((step, i) => {
                  const at = plan.indexOf(current);
                  const state = i < at ? "done" : i === at ? "now" : "next";
                  return (
                    <li key={step} className={`flex items-center gap-2 ${state === "next" ? "text-ink-40" : "text-ink"}`}>
                      <span className="w-3">{state === "done" ? "✓" : state === "now" ? <Spinner /> : `${i + 1}`}</span>
                      {STEP_LABELS[step]}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
