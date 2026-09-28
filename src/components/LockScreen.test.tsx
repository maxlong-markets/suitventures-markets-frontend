import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@/lib/types";
import type { SuitsAccess } from "@/lib/suits";
import { fireEvent, render, screen } from "@/test/dom";
import LockScreen from "./LockScreen";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;

const h = vi.hoisted(() => ({
  openConnectModal: vi.fn(),
  openAccountModal: vi.fn(),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: h.openConnectModal }),
  useAccountModal: () => ({ openAccountModal: h.openAccountModal }),
}));

function show(access: SuitsAccess, address?: Address) {
  return render(<LockScreen access={access} address={address} />);
}

describe("LockScreen", () => {
  beforeEach(() => {
    h.openConnectModal.mockReset();
    h.openAccountModal.mockReset();
  });

  it("idle: shows its own headline and opens the connect modal", () => {
    show({ status: "idle" });
    expect(screen.getByRole("heading", { name: "This floor is for Suits." })).toBeTruthy();
    fireEvent.click(screen.getByText("Connect Wallet"));
    expect(h.openConnectModal).toHaveBeenCalled();
  });

  it("checking: shows its own headline and a spinner, no button", () => {
    show({ status: "checking" });
    expect(screen.getByRole("heading", { name: "Checking the guest list." })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("denied: shows its own headline, the truncated wallet, and links to the OpenSea collection", () => {
    show({ status: "denied", count: 0n }, WALLET);

    expect(screen.getByRole("heading", { name: "No Suit on this wallet." })).toBeTruthy();
    expect(screen.getByText(/0x1111…1111 holds 0 Suits\./)).toBeTruthy();

    const link = screen.getByText("Get a Suit ↗").closest("a");
    expect(link?.getAttribute("href")).toBe("https://opensea.io/collection/the-suits-nft");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");

    fireEvent.click(screen.getByText("Use Another Wallet"));
    expect(h.openAccountModal).toHaveBeenCalled();
  });

  it("error: shows its own headline and a Retry button that calls access.retry", () => {
    const retry = vi.fn();
    show({ status: "error", retry });

    expect(screen.getByRole("heading", { name: "Couldn't reach the chain." })).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  // This shipped broken once and nothing caught it: `outline-none` pairs with the bare
  // `focus-visible:outline` to set outline-style: none even in the focus state, so the ring had
  // a width and a colour and painted nothing. Tailwind resolves that at build time, so assert on
  // the class the component asks for — the utility that names the style is the load-bearing part.
  it("names an outline style in the focus-visible ring, so it actually paints", () => {
    show({ status: "denied", count: 0n }, WALLET);
    const link = screen.getByText("Get a Suit ↗").closest("a");
    expect(link?.className).toContain("focus-visible:outline-solid");
    expect(link?.className).not.toMatch(/focus-visible:outline(?![-:])/);
  });

  it("denied: falls back to neutral copy when no address came down", () => {
    show({ status: "denied", count: 0n });
    expect(screen.getByText(/^This wallet holds 0 Suits\./)).toBeTruthy();
  });

  // The walls are part of the frame, not of any one state, and they are decoration: a screen
  // reader should hear the gate's copy, not 36 nameless images.
  it("frames every state with two walls of Suits, hidden from assistive tech", () => {
    for (const access of [
      { status: "idle" },
      { status: "checking" },
      { status: "denied", count: 0n },
      { status: "error", retry: vi.fn() },
    ] as SuitsAccess[]) {
      const { container, unmount } = show(access, WALLET);
      const tiles = container.querySelectorAll('img[src^="/suits/"]');
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) {
        expect(tile.getAttribute("alt")).toBe("");
        expect(tile.closest("[aria-hidden]")).not.toBeNull();
      }
      unmount();
    }
  });

  // Each wall renders the tile list twice so the -50% translate loops without a seam. An odd
  // count means someone changed one and not the other, and the loop would visibly jump.
  it("renders each wall's tile list exactly twice, so the loop has no seam", () => {
    const { container } = show({ status: "idle" });
    const walls = container.querySelectorAll("[aria-hidden]");
    expect(walls.length).toBe(2);
    for (const wall of walls) {
      const tiles = wall.querySelectorAll('img[src^="/suits/"]');
      const unique = new Set([...tiles].map((t) => t.getAttribute("src")));
      expect(tiles.length).toBe(unique.size * 2);
    }
  });

  it("error: never renders denial copy", () => {
    show({ status: "error", retry: vi.fn() });

    expect(screen.queryByText(/holds 0 Suits/)).toBeNull();
    expect(screen.queryByText("Get a Suit ↗")).toBeNull();
    expect(screen.queryByText("Use Another Wallet")).toBeNull();
    expect(screen.queryByText("No Suit on this wallet.")).toBeNull();
  });
});
