import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import TradersPage, { metadata } from "./page";

// TradersBoard.test.tsx already covers the board's own behaviour in depth; this only has to prove
// the page mounts it, so the hook is stubbed at the smallest shape that lets the board render.
vi.mock("@/hooks/useMarketsData", () => ({
  useTraders: () => ({ data: [], isPending: false, isError: false, error: undefined }),
}));

describe("TradersPage", () => {
  it("titles the tab 'Traders'", () => {
    expect(metadata.title).toBe("Traders");
  });

  it("mounts the traders board", () => {
    render(<TradersPage />);
    expect(screen.getByText("No trades in the last 24 hours.")).toBeTruthy();
  });
});
