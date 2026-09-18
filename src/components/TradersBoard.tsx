"use client";

import { useState } from "react";
import { useTraders } from "@/hooks/useMarketsData";
import { addressUrl } from "@/lib/chain";
import { StoreUnavailableError } from "@/lib/data/envio";
import { fmtInt, fmtUsd, short } from "@/lib/format";
import type { TradersBy } from "@/lib/types";

const COLS =
  "grid grid-cols-[32px_minmax(0,1fr)_100px_64px] items-center gap-[10px] tablet:grid-cols-[32px_minmax(0,1fr)_120px_80px_80px]";

const ORDERINGS: ReadonlyArray<readonly [TradersBy, string]> = [
  ["volume", "24h volume"],
  ["trades", "Trades"],
];

function RowsSkeleton() {
  return (
    <div aria-busy>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex h-8 items-center border-b border-hairline-soft">
          <span className="skeleton h-[10px]" style={{ width: 140 + ((i * 37) % 180) }} />
        </div>
      ))}
    </div>
  );
}

function Note({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="border-t border-hairline px-4 py-[72px] text-center">
      <div className="mb-[6px] text-[17px]">{title}</div>
      <div className="text-[12.5px] text-ink-50">{sub}</div>
    </div>
  );
}

export default function TradersBoard() {
  const [by, setBy] = useState<TradersBy>("volume");
  const { data, isPending, isError, error } = useTraders(by);
  const rows = data ?? [];

  return (
    <>
      <div className="mt-[14px] flex gap-[22px] border-b border-hairline" role="group" aria-label="Rank by">
        {ORDERINGS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={by === key}
            onClick={() => setBy(key)}
            className={`-mb-px h-[34px] border-b bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.22em] hover:text-white ${
              by === key ? "border-ink text-ink" : "border-transparent text-ink-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isError ? (
        // The store is a deployment step, not a bug: say which of the two it is in plain words.
        error instanceof StoreUnavailableError ? (
          <Note
            title="The traders board needs the market store."
            sub="It turns on with the project's database. Everything else on the site is unaffected."
          />
        ) : (
          <Note title="Couldn't load the traders board." sub="Reload the page to try again." />
        )
      ) : (
        <div className="font-mono text-[12px] tabular-nums">
          <div className={`${COLS} h-[30px] border-b border-hairline text-[9.5px] uppercase tracking-[0.16em] text-ink-40`}>
            <div>#</div>
            <div>Wallet</div>
            <div className="text-right">24h volume</div>
            <div className="text-right">Trades</div>
            <div className="hidden text-right tablet:block">Tokens</div>
          </div>
          {isPending ? (
            <RowsSkeleton />
          ) : rows.length === 0 ? (
            <Note title="No trades in the last 24 hours." sub="The board fills as the chain does." />
          ) : (
            rows.map((t, i) => (
              <div
                key={t.wallet}
                className={`${COLS} h-8 whitespace-nowrap border-b border-hairline-soft hover:bg-hover-soft`}
              >
                <div className="text-ink-40">{i + 1}</div>
                <a
                  href={addressUrl(t.wallet)}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-ink-70 hover:text-ink"
                >
                  {short(t.wallet)}
                </a>
                <div className="text-right">{fmtUsd(t.volumeUsd)}</div>
                <div className="text-right text-ink-70">{fmtInt(t.trades)}</div>
                <div className="hidden text-right text-ink-70 tablet:block">{fmtInt(t.tokens)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
