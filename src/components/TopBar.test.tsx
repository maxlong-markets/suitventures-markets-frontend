import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import TopBar from "./TopBar";

vi.mock("next/navigation", () => ({ usePathname: () => "/launch", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/AppState", () => ({ useAppState: () => ({ filters: { query: "" }, setQuery: vi.fn() }) }));
vi.mock("./WalletButton", () => ({ default: () => null }));

describe("TopBar (instant launchpad design, section 7.1)", () => {
  it("offers Launch after Watchlist in both the desktop and the phone rows, marked current on /launch", () => {
    render(<TopBar />);
    const links = screen.getAllByRole("link", { name: "Launch" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/launch");
      expect(link.getAttribute("aria-current")).toBe("page");
    }
    // The Traders tab was removed on 30 Sep 2026: its board is parked behind TRADERS_BOARD, and /traders is gone.
    const rows = screen.getAllByRole("navigation", { name: "Primary" });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Markets", "Watchlist", "Launch"]);
    }
    expect(screen.queryByRole("link", { name: "Traders" })).toBeNull();
  });
});
