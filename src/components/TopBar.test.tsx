import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import TopBar from "./TopBar";

vi.mock("next/navigation", () => ({ usePathname: () => "/launch", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/AppState", () => ({ useAppState: () => ({ filters: { query: "" }, setQuery: vi.fn() }) }));
vi.mock("./WalletButton", () => ({ default: () => null }));

describe("TopBar (instant launchpad design, section 7.1)", () => {
  it("offers Launch after Traders in both the desktop and the phone rows, marked current on /launch", () => {
    render(<TopBar />);
    const links = screen.getAllByRole("link", { name: "Launch" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/launch");
      expect(link.getAttribute("aria-current")).toBe("page");
    }
    const [desktop] = screen.getAllByRole("navigation", { name: "Primary" });
    expect([...desktop!.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Markets", "Watchlist", "Traders", "Launch"]);
  });
});
