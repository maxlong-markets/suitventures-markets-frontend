import { describe, expect, it, vi } from "vitest";
import type { Address, QuoteAsset } from "@/lib/types";
import { fireEvent, render, screen } from "@/test/dom";
import CurrencySelect from "./CurrencySelect";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address;
const QUOTES: QuoteAsset[] = [
  { symbol: "NVDA", name: "NVIDIA", address: NVDA, decimals: 18, usdPrice: 120, pairs: 3, vol24h: 900, stale: false },
  { symbol: "USDG", name: "Global Dollar", address: USDG, decimals: 6, usdPrice: 1, pairs: 5, vol24h: 100, stale: false },
];

function show() {
  const onChange = vi.fn();
  render(
    <div>
      <CurrencySelect quotes={QUOTES} value={USDG} onChange={onChange} />
      <p>elsewhere</p>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: /Currency/ });
  fireEvent.click(trigger);
  expect(screen.getByRole("listbox")).toBeTruthy();
  return { trigger, onChange };
}

describe("CurrencySelect closing", () => {
  it("closes on Escape and hands focus back to its trigger", () => {
    const { trigger } = show();
    fireEvent.keyDown(screen.getByLabelText("Find a currency"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a press outside it", () => {
    show();
    fireEvent.mouseDown(screen.getByText("elsewhere"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays open on a press inside it", () => {
    show();
    fireEvent.mouseDown(screen.getByLabelText("Find a currency"));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("returns focus to its trigger after a pick", () => {
    const { trigger, onChange } = show();
    fireEvent.click(screen.getByRole("option", { name: /NVDA/ }));
    expect(onChange).toHaveBeenCalledWith(NVDA);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
