import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import LaunchPage, { metadata } from "./page";

const h = vi.hoisted(() => ({ live: false }));
vi.mock("@/lib/launch/address", () => ({ hasLaunchpad: () => h.live, LAUNCHPAD_ADDRESS: undefined }));
vi.mock("@/components/LaunchForm", () => ({ default: () => <div>the launch form</div> }));
vi.mock("@/components/YourLaunches", () => ({ default: () => <div>your launches</div> }));

describe("/launch (instant launchpad design, section 7.2)", () => {
  it("is titled Launch", () => {
    expect(metadata.title).toBe("Launch");
  });

  it("shows only the not-live card while the launchpad address is unset", () => {
    h.live = false;
    render(<LaunchPage />);
    expect(screen.getByText("Launching is not live yet")).toBeTruthy();
    expect(screen.getByText("Token launches open here once the launchpad contract is deployed.")).toBeTruthy();
    expect(screen.queryByText("the launch form")).toBeNull();
    expect(screen.queryByText("your launches")).toBeNull();
  });

  it("shows the form once it is set, and the wallet's own launches under it (amended 30 Sep 2026)", () => {
    h.live = true;
    const { container } = render(<LaunchPage />);
    expect(screen.getByText("the launch form")).toBeTruthy();
    expect(screen.queryByText("Launching is not live yet")).toBeNull();
    expect(container.textContent).toMatch(/the launch form.*your launches/);
  });

  // UX review, should fix 1: a creator expecting a team allocation or automatic payouts found out only after paying.
  // Reworded in fix round 1 (ruling 2) to claim no more than the contract does: the tokens leave the pool as people buy,
  // only the liquidity is locked; the creator can also buy later; other people can add liquidity and share the fee.
  it("explains the model in three plain lines above the form, claiming no more than the contract does", () => {
    h.live = true;
    const { container } = render(<LaunchPage />);
    const lines = [
      "A fixed supply of 1,000,000,000 tokens goes into a Uniswap v4 pool as liquidity that nobody can withdraw.",
      "Launching gives you no tokens. To start with some, make a first buy in the same transaction.",
      "Every trade pays a 1 % pool fee. You collect your fees on the token's page.",
    ];
    for (const line of lines) expect(screen.getByText(line)).toBeTruthy();
    expect(container.textContent).toMatch(/withdraw\..*collect your fees on the token's page\..*the launch form/);
    // Fix round 1, ruling 10: a number never parts from its percent sign at the end of a line.
    expect(container.textContent).toMatch(/1\u{A0}%/u);
    expect(container.textContent).not.toMatch(/\d %/);
  });

  it("keeps the lines off the not-live card", () => {
    h.live = false;
    render(<LaunchPage />);
    expect(screen.queryByText(/nobody can withdraw/)).toBeNull();
  });
});
