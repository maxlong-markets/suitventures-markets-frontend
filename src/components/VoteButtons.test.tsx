import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/dom";
import VoteButtons from "./VoteButtons";

const bullish = () => screen.getByRole("button", { name: /Bullish/ });
const bearish = () => screen.getByRole("button", { name: /Bearish/ });

describe("VoteButtons", () => {
  it("shows both counts and presses the side this wallet voted", () => {
    render(<VoteButtons bull={4} bear={1} voted="bull" onVote={vi.fn()} />);
    expect(bullish().textContent).toContain("4");
    expect(bearish().textContent).toContain("1");
    expect(bullish().getAttribute("aria-pressed")).toBe("true");
    expect(bearish().getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * The 23 Sep report's third symptom — spam-clicking left the counts at -1, 0 or 2 — is fixed in
   * `AppState`, which takes one write per token at a time. This is the half the user can see: while
   * that write is out, both buttons say so rather than looking like a click that did nothing.
   */
  it("reports a vote in flight on both buttons, and still reaches the handler that ignores it", () => {
    const onVote = vi.fn();
    render(<VoteButtons bull={4} bear={1} voted="bull" pending onVote={onVote} />);
    expect(bullish().getAttribute("aria-busy")).toBe("true");
    expect(bearish().getAttribute("aria-busy")).toBe("true");
    // Muted rather than disabled: a disabled button drops focus mid-interaction, and the click is
    // already a no-op one layer up.
    expect(bullish().className).toContain("opacity-50");
    fireEvent.click(bearish());
    expect(onVote).toHaveBeenCalledWith("bear");
  });

  it("says nothing about being busy when no write is out", () => {
    render(<VoteButtons bull={0} bear={0} onVote={vi.fn()} />);
    expect(bullish().getAttribute("aria-busy")).toBe("false");
    expect(bullish().className).not.toContain("opacity-50");
  });
});
