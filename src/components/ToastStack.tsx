"use client";

import { useAppState, type Toast } from "@/context/AppState";
import { txUrl } from "@/lib/chain";
import { short } from "@/lib/format";
import { Spinner } from "./ui";

function StatusDot({ kind }: { kind: Toast["kind"] }) {
  // "unconfirmed" is styled exactly like "pending": it is not a failure, and its own message
  // (not this dot) carries the nuance.
  if (kind === "pending" || kind === "unconfirmed") {
    return (
      <span className="mt-[3px] flex flex-none">
        <Spinner />
      </span>
    );
  }
  if (kind === "confirmed") {
    return <span className="mt-[3px] h-3 w-3 flex-none rounded-full bg-chalk" />;
  }
  return (
    <span className="mt-[3px] h-3 w-3 flex-none rounded-full border-[1.5px] border-ink-60" />
  );
}

export default function ToastStack() {
  const { toasts, dismissToast } = useAppState();
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-[20] flex max-w-[calc(100%-32px)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex w-full max-w-full items-start gap-3 border border-hairline-strong bg-panel px-[14px] py-3 tablet:w-[320px]"
        >
          <StatusDot kind={t.kind} />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink-45">
              {t.kind}
            </div>
            <div className="mt-[3px] text-pretty text-[12.5px]">{t.message}</div>
            {t.hash ? (
              <a
                href={txUrl(t.hash)}
                target="_blank"
                rel="noreferrer"
                className="mt-[6px] inline-block font-mono text-[10.5px] text-ink-50 hover:text-ink"
              >
                View tx {short(t.hash)} ↗
              </a>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="bg-transparent p-0 text-[15px] leading-none text-ink-40 hover:text-ink"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
