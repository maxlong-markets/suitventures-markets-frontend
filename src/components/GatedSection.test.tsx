import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuitsAccess } from "@/lib/suits";
import { fireEvent, render, screen } from "@/test/dom";
import GatedSection from "./GatedSection";

const WALLET = "0x1111111111111111111111111111111111111111";

const h = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as string | undefined,
  access: { status: "idle" } as SuitsAccess,
  gateEnabled: vi.fn(() => true),
  openConnectModal: vi.fn(),
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => ({ address: h.address }) }));
vi.mock("@/lib/suits", () => ({
  useSuitsAccess: () => h.access,
  gateEnabled: h.gateEnabled,
}));
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: h.openConnectModal }),
}));

const CHILDREN = <div data-testid="section-content">TokenView</div>;

describe("GatedSection", () => {
  beforeEach(() => {
    h.address = WALLET;
    h.gateEnabled.mockReset().mockReturnValue(true);
    h.openConnectModal.mockReset();
  });

  it("renders children when access is granted", () => {
    h.access = { status: "granted", count: 3n };
    render(<GatedSection>{CHILDREN}</GatedSection>);
    expect(screen.getByTestId("section-content")).toBeTruthy();
  });

  it("renders children regardless of status when the gate is disabled", () => {
    h.gateEnabled.mockReturnValue(false);
    h.access = { status: "denied", count: 0n };
    render(<GatedSection>{CHILDREN}</GatedSection>);
    expect(screen.getByTestId("section-content")).toBeTruthy();
  });

  it("idle: shows a compact locked card with a Connect Wallet action, not the children", () => {
    h.access = { status: "idle" };
    render(<GatedSection>{CHILDREN}</GatedSection>);
    expect(screen.queryByTestId("section-content")).toBeNull();
    expect(screen.getByText("This section is for Suits holders.")).toBeTruthy();
    fireEvent.click(screen.getByText("Connect Wallet"));
    expect(h.openConnectModal).toHaveBeenCalled();
  });

  it("checking: shows its own copy and no action button", () => {
    h.access = { status: "checking" };
    render(<GatedSection>{CHILDREN}</GatedSection>);
    expect(screen.queryByTestId("section-content")).toBeNull();
    expect(screen.getByText("Checking for a Suit.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("denied: names the wallet and links to the OpenSea collection", () => {
    h.access = { status: "denied", count: 0n };
    render(<GatedSection>{CHILDREN}</GatedSection>);
    expect(screen.queryByTestId("section-content")).toBeNull();
    expect(screen.getByText(/0x1111…1111 holds 0 Suits\./)).toBeTruthy();
    const link = screen.getByText("Get a Suit ↗").closest("a");
    expect(link?.getAttribute("href")).toBe("https://opensea.io/collection/the-suits-nft");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  // The regression this type exists to prevent (src/lib/suits.ts): an RPC failure must never be
  // reported as a confirmed "you own zero", which would tell a genuine holder they are not one.
  it("error: does not claim the wallet holds nothing, and offers Retry instead", () => {
    const retry = vi.fn();
    h.access = { status: "error", retry };
    render(<GatedSection>{CHILDREN}</GatedSection>);
    expect(screen.queryByTestId("section-content")).toBeNull();
    expect(screen.queryByText(/holds 0 Suits/)).toBeNull();
    expect(screen.queryByText("No Suit on this wallet.")).toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalled();
  });
});
