import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairsScope } from "@/lib/envio/pairs";
import type { TokenPair } from "@/lib/types";
import sitemap from "./sitemap";

const { pairs } = vi.hoisted(() => ({
  pairs: vi.fn<(scope: PairsScope) => Promise<TokenPair[]>>(),
}));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "db", pairs }) }));

const T1 = `0x${"1".repeat(40)}`;
const pair = (address: string) => ({ address, id: address }) as TokenPair;

beforeEach(() => {
  pairs.mockReset();
});

describe("sitemap", () => {
  it("includes the homepage and a token entry per listed pair", async () => {
    pairs.mockResolvedValue([pair(T1)]);
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain("https://www.maxlong.markets");
    expect(urls).toContain(`https://www.maxlong.markets/t/${T1}`);
  });

  // /watchlist is one wallet's own list; a crawler gets the signed-out empty copy, thin content
  // that would waste the crawl budget the token pages need. /traders is no route since 30 Sep
  // 2026 and must not be listed either. /launch is a real public page since the gate came down
  // (9 Oct 2026) and belongs in.
  it("lists /launch, and leaves /watchlist and the removed /traders out", async () => {
    pairs.mockResolvedValue([pair(T1)]);
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain("https://www.maxlong.markets/launch");
    expect(urls).not.toContain("https://www.maxlong.markets/traders");
    expect(urls).not.toContain("https://www.maxlong.markets/watchlist");
  });

  it("lowercases the token address in case the backend ever hands back a checksummed one", async () => {
    pairs.mockResolvedValue([pair(`0x${"A".repeat(40)}`)]);
    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toContain(`https://www.maxlong.markets/t/0x${"a".repeat(40)}`);
  });

  it("returns just the static routes, not a 500, when the backend throws", async () => {
    pairs.mockRejectedValue(new Error("db unavailable"));
    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toEqual(["https://www.maxlong.markets", "https://www.maxlong.markets/launch"]);
  });

  it("caps the token entries well under Google's per-sitemap comfort zone", async () => {
    pairs.mockResolvedValue(Array.from({ length: 500 }, (_, i) => pair(`0x${String(i).padStart(40, "0")}`)));
    const entries = await sitemap();
    expect(entries.length).toBeLessThanOrEqual(302); // the homepage, /launch, and the 300-token cap
  });
});
