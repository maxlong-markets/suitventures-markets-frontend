"use client";

import { useAppState } from "@/context/AppState";
import { LAUNCHPAD_OPTIONS, PRESETS } from "@/lib/markets";

interface Props {
  total: number;
  loading: boolean;
}

export default function MarketsToolbar({ total, loading }: Props) {
  const { filters, setPreset, setLaunchpad } = useAppState();
  const sel = filters.quotes;
  const count = loading
    ? "Loading"
    : `${total} pair${total === 1 ? "" : "s"}` +
      (sel.length
        ? " · " + (sel.length > 3 ? `${sel.length} quotes` : sel.join(", "))
        : "");

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-[10px] py-[14px]">
      <div
        className="no-scrollbar flex max-w-full overflow-x-auto border border-hairline-strong"
        role="group"
        aria-label="Preset"
      >
        {PRESETS.map((p, i) => {
          const on = filters.preset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              aria-pressed={on}
              className={`h-7 whitespace-nowrap px-3 text-[11.5px] hover:text-white ${
                i < PRESETS.length - 1 ? "border-r border-hairline-mid" : ""
              } ${on ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-60"}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="flex max-w-full items-center gap-[10px]">
        <span className="hidden font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-40 tablet:inline">
          Launchpad
        </span>
        <div
          className="no-scrollbar flex overflow-x-auto border border-hairline-strong"
          role="group"
          aria-label="Launchpad"
        >
          {LAUNCHPAD_OPTIONS.map((o, i) => {
            const on = filters.launchpad === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => setLaunchpad(o.key)}
                aria-pressed={on}
                className={`h-7 whitespace-nowrap px-[10px] font-mono text-[9.5px] tracking-[0.14em] hover:text-white ${
                  i < LAUNCHPAD_OPTIONS.length - 1
                    ? "border-r border-hairline-mid"
                    : ""
                } ${on ? "bg-chalk-10 text-chalk" : "bg-transparent text-ink-60"}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="ml-auto whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-40"
        aria-live="polite"
      >
        {count}
      </div>
    </div>
  );
}
