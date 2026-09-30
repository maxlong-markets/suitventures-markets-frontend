import type { FactRows } from "@/lib/tokenFacts";

/**
 * A token's details in two parts: the six figures a trader looks for first, always on screen as a compact grid, and
 * everything else behind a native <details> reading "All details", closed until asked for. No hooks and no client
 * directive, so the public block renders it on the server as real text and the card under the trade panel renders it
 * in the browser from the same rows. `wide` spreads both parts over more columns where the block has the page's full
 * width.
 */
export default function TokenFactsList({ rows, wide = false }: { rows: FactRows; wide?: boolean }) {
  return (
    <>
      <dl className={`m-0 grid grid-cols-2 gap-x-6 ${wide ? "tablet:grid-cols-3" : ""}`}>
        {rows.key.map(({ label, value, toneClass }) => (
          <div key={label} className="m-0 border-b border-hairline-soft py-[9px]">
            <dt className="m-0 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-40">{label}</dt>
            <dd className={`m-0 mt-[4px] truncate font-mono text-[12.5px] tabular-nums ${toneClass ?? ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <details className="group">
        <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-[8px] [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden
            className="inline-block flex-none text-[13px] leading-none text-ink-50 transition-transform duration-150 group-open:rotate-45"
          >
            +
          </span>
          <span className="flex-none font-mono text-[10px] uppercase tracking-[0.16em] text-ink-55">All details</span>
        </summary>
        <dl className={`m-0 grid grid-cols-1 gap-x-8 ${wide ? "tablet:grid-cols-2" : ""}`}>
          {rows.more.map(({ label, value, href, toneClass, note }) => (
            <div key={label} className="m-0 border-b border-hairline-soft py-[11px] font-mono text-[12.5px] tabular-nums">
              <div className="flex justify-between gap-4">
                <dt className="m-0 flex-none text-[10px] uppercase tracking-[0.16em] text-ink-40">{label}</dt>
                <dd className={`m-0 truncate text-right ${toneClass ?? ""}`}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-ink-70 hover:text-ink">
                      {value}
                    </a>
                  ) : (
                    value
                  )}
                </dd>
              </div>
              {note ? (
                <p className="m-0 mt-[6px] text-pretty text-left font-sans text-[11px] leading-[1.5] text-ink-50">{note}</p>
              ) : null}
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
