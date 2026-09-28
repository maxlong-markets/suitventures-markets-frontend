import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuitsAccess } from "@/lib/suits";
import { render, screen } from "@/test/dom";
import TokenGate from "./TokenGate";

const WALLET = "0x1111111111111111111111111111111111111111";

const h = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as string | undefined,
  access: { status: "idle" } as SuitsAccess,
  gateEnabled: vi.fn(() => true),
  /** Records what TokenGate actually asked the balance of, so the pass-through is testable. */
  askedFor: vi.fn(),
  pathname: "/" as string,
}));

vi.mock("@/context/AppState", () => ({ useAppState: () => ({ address: h.address }) }));
vi.mock("@/lib/suits", () => ({
  useSuitsAccess: (address?: string) => {
    h.askedFor(address);
    return h.access;
  },
  gateEnabled: h.gateEnabled,
}));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
// A stub that surfaces only what this suite needs to see — the status TokenGate handed it, and
// the wallet it named — so a wrong branch shows up as wrong text rather than requiring this file
// to know anything about LockScreen's real markup, which has its own tests.
vi.mock("@/components/LockScreen", () => ({
  default: ({ access, address }: { access: SuitsAccess; address?: string }) => (
    <div data-testid="lock-screen" data-address={address ?? ""}>
      {access.status}
    </div>
  ),
}));

const CHILDREN = <div data-testid="app">The app</div>;

describe("TokenGate", () => {
  beforeEach(() => {
    h.address = WALLET;
    h.gateEnabled.mockReset().mockReturnValue(true);
    h.askedFor.mockClear();
    h.pathname = "/";
  });

  // The gate deliberately has no mount gate: pinning the address to undefined until after
  // hydration would make the very first render of a returning, cookie-seeded wallet claim
  // "no wallet connected" and offer a CONNECT WALLET button RainbowKit leaves inert while the
  // connection is reconnecting. The balance must be asked about the wallet the tree already has.
  it("asks about the connected wallet on the first render, with no mount gate", () => {
    h.access = { status: "checking" };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(h.askedFor).toHaveBeenCalledWith(WALLET);
    expect(h.askedFor).not.toHaveBeenCalledWith(undefined);
  });

  // The denial copy names a wallet; it must be the wallet the balance was read against, not a
  // second, independently-read one.
  it("hands the same wallet to the lock screen that it checked", () => {
    h.access = { status: "denied", count: 0n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.getByTestId("lock-screen").getAttribute("data-address")).toBe(WALLET);
  });

  it("renders the children when access is granted", () => {
    h.access = { status: "granted", count: 3n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByTestId("lock-screen")).toBeNull();
  });

  it("renders the lock screen, not the children, while idle", () => {
    h.access = { status: "idle" };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByTestId("lock-screen").textContent).toBe("idle");
  });

  it("renders the lock screen, not the children, while checking", () => {
    h.access = { status: "checking" };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByTestId("lock-screen").textContent).toBe("checking");
  });

  it("renders the lock screen, not the children, when denied", () => {
    h.access = { status: "denied", count: 0n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByTestId("lock-screen").textContent).toBe("denied");
  });

  it("renders the lock screen, not the children, on error", () => {
    h.access = { status: "error", retry: vi.fn() };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByTestId("lock-screen").textContent).toBe("error");
  });

  it("renders the children regardless of status when the gate is disabled", () => {
    h.gateEnabled.mockReturnValue(false);
    h.access = { status: "denied", count: 0n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByTestId("lock-screen")).toBeNull();
  });

  // The whole reason /t/[address] is exempt: Googlebot is always denied, and it must still get
  // the page's own public facts layer rather than the lock screen (2026-09-28 SEO work).
  it("renders children on a /t/... path even when access is denied", () => {
    h.pathname = "/t/0xabc";
    h.access = { status: "denied", count: 0n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByTestId("lock-screen")).toBeNull();
  });

  it("renders children on a /t/... path even when checking or erroring", () => {
    h.pathname = "/t/0xabc";
    h.access = { status: "error", retry: vi.fn() };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByTestId("lock-screen")).toBeNull();
  });

  // The prefix trap: "/traders" starts with the same two letters as "/t/" but has no public
  // layer of its own, so it must stay fully gated — a naive `startsWith("/t")` would exempt it.
  it("still renders the lock screen on /traders when denied", () => {
    h.pathname = "/traders";
    h.access = { status: "denied", count: 0n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByTestId("lock-screen").textContent).toBe("denied");
  });

  it("renders the lock screen on / when denied, unchanged", () => {
    h.pathname = "/";
    h.access = { status: "denied", count: 0n };
    render(<TokenGate>{CHILDREN}</TokenGate>);
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByTestId("lock-screen").textContent).toBe("denied");
  });
});
