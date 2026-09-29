import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  IPFS_GATEWAYS,
  MAX_REDIRECTS,
  clearLogoCache,
  guardedFetch,
  isAllowedImageType,
  isAllowedLogoUrl,
  normaliseImageType,
  resolveLogo,
  toHttpCandidates,
  type LogoDeps,
} from "./resolve";

const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18"; // Doppler DERC20: tokenURI() JSON
const BABYHOOD = "0x8bf7552675486577298af40f78b4f1930aca1bae"; // Pons: logo() ipfs://
const UNI = "0x1111111111111111111111111111111111111111"; // neither read answers

const CID = "bafybeibrdjatj5eu5b45vzibpsnu5qhc6ruzemzzhjvkiwgreer6szqhyy";
const IMAGE_CID = "bafkreihtnj2ch4yi4hmj22zd53xmyeevn4ewglv4ksh7ikdnriphilicxq";
const NOW = 1_789_547_000_000;

const gateways = (suffix: string) => IPFS_GATEWAYS.map((g) => `${g}${suffix}`);

/** A definite answer from the chain: this token has `value` for `fn`, and nothing for the other. */
const answers = (fn: "logo" | "tokenURI", value: string) =>
  vi.fn<LogoDeps["readString"]>(async (_a, which) => ({ ok: true, value: which === fn ? value : null }));

type MockDeps = {
  readString: Mock<LogoDeps["readString"]>;
  fetchJson: Mock<LogoDeps["fetchJson"]>;
  now: Mock<LogoDeps["now"]>;
  launchImage: Mock<LogoDeps["launchImage"]>;
};

/** Every dep answers "nothing" unless a case overrides it, so no test can reach the network. */
function deps(over: Partial<MockDeps> = {}): MockDeps {
  return {
    readString: vi.fn<LogoDeps["readString"]>(async () => ({ ok: true, value: null })),
    fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => {
      throw new Error("unexpected fetch");
    }),
    now: vi.fn<LogoDeps["now"]>(() => NOW),
    launchImage: vi.fn<LogoDeps["launchImage"]>(async () => ({ ok: true, row: null })),
    ...over,
  };
}

beforeEach(() => {
  clearLogoCache();
});

describe("toHttpCandidates", () => {
  it("maps an ipfs uri onto every gateway, in order", () => {
    expect(toHttpCandidates(`ipfs://${CID}`)).toEqual(gateways(CID));
    expect(toHttpCandidates(`ipfs://${CID}`)).toHaveLength(5);
    expect(toHttpCandidates(`ipfs://${CID}`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${CID}`);
    expect(toHttpCandidates(`ipfs://${CID}`)[1]).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
  });

  it("keeps the path that follows the CID", () => {
    expect(toHttpCandidates(`ipfs://${CID}/logo.png`)).toEqual(gateways(`${CID}/logo.png`));
  });

  it("strips a doubled ipfs prefix", () => {
    expect(toHttpCandidates(`ipfs://ipfs/${CID}`)).toEqual(gateways(CID));
  });

  it("passes https through unchanged, as one candidate", () => {
    expect(toHttpCandidates("https://dd.dexscreener.com/ds-data/tokens/a.png")).toEqual([
      "https://dd.dexscreener.com/ds-data/tokens/a.png",
    ]);
  });

  it("drops plain http, which the guard would refuse anyway", () => {
    expect(toHttpCandidates("http://example.test/a.png")).toEqual([]);
  });

  it("rejects anything that is not fetchable", () => {
    expect(toHttpCandidates("")).toEqual([]);
    expect(toHttpCandidates("   ")).toEqual([]);
    expect(toHttpCandidates("ipfs://")).toEqual([]);
    expect(toHttpCandidates("data:image/png;base64,iVBORw0KGgo=")).toEqual([]);
    expect(toHttpCandidates("just a name")).toEqual([]);
  });
});

describe("resolveLogo", () => {
  it("reads a Pons logo() first and never asks anything else", async () => {
    const d = deps({ readString: answers("logo", `ipfs://${CID}`) });
    await expect(resolveLogo(BABYHOOD, d)).resolves.toEqual({
      logo: { candidates: gateways(CID), source: "pons" },
      definite: true,
    });
    expect(d.readString).toHaveBeenCalledTimes(1);
    expect(d.readString).toHaveBeenCalledWith(BABYHOOD, "logo", 5000);
    expect(d.fetchJson).not.toHaveBeenCalled();
  });

  it("falls through an empty logo() to tokenURI() and takes image_hash from the JSON", async () => {
    const d = deps({
      readString: answers("tokenURI", `ipfs://${CID}`),
      fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ name: "Artificial Inu", image_hash: `ipfs://${IMAGE_CID}` })),
    });
    await expect(resolveLogo(AI, d)).resolves.toEqual({
      logo: { candidates: gateways(IMAGE_CID), source: "long" },
      definite: true,
    });
    expect(d.readString.mock.calls.map((c) => c[1])).toEqual(["logo", "tokenURI"]);
    expect(d.fetchJson).toHaveBeenCalledTimes(1);
    expect(d.fetchJson).toHaveBeenCalledWith(`https://ipfs.filebase.io/ipfs/${CID}`, 5000);
  });

  it("accepts image as an alias for image_hash", async () => {
    const d = deps({
      readString: answers("tokenURI", `ipfs://${CID}`),
      fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ image: `ipfs://${IMAGE_CID}` })),
    });
    await expect(resolveLogo(AI, d)).resolves.toEqual({
      logo: { candidates: gateways(IMAGE_CID), source: "long" },
      definite: true,
    });
  });

  it("fails over to the next gateway when the first one does not answer", async () => {
    const fetchJson = vi
      .fn<LogoDeps["fetchJson"]>()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce({ image_hash: `ipfs://${IMAGE_CID}` });
    const d = deps({ readString: answers("tokenURI", `ipfs://${CID}`), fetchJson });
    // One gateway failing is not a failure to ask: another answered, so this is still definite.
    await expect(resolveLogo(AI, d)).resolves.toEqual({
      logo: { candidates: gateways(IMAGE_CID), source: "long" },
      definite: true,
    });
    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      `https://ipfs.filebase.io/ipfs/${CID}`,
      `https://gateway.pinata.cloud/ipfs/${CID}`,
    ]);
  });

  it("falls back to DexScreener when neither read answers, taking the first pair with an image", async () => {
    const d = deps({
      fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({
        pairs: [
          { info: {} },
          { info: { imageUrl: "https://dd.dexscreener.com/ds-data/tokens/rh/0x1.png" } },
          { info: { imageUrl: "https://dd.dexscreener.com/ds-data/tokens/rh/0x2.png" } },
        ],
      })),
    });
    await expect(resolveLogo(UNI, d)).resolves.toEqual({
      logo: { candidates: ["https://dd.dexscreener.com/ds-data/tokens/rh/0x1.png"], source: "dexscreener" },
      definite: true,
    });
    expect(d.fetchJson.mock.calls[0]![0]).toBe(`https://api.dexscreener.com/latest/dex/tokens/${UNI}`);
  });

  it("memoises a definite no everywhere for an hour", async () => {
    const miss = { logo: null, definite: true };
    const d = deps({ fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [] })) });
    await expect(resolveLogo(UNI, d)).resolves.toEqual(miss);
    expect(d.readString).toHaveBeenCalledTimes(2);
    expect(d.fetchJson).toHaveBeenCalledTimes(1);

    // Inside the hour: served from the memo, nothing is asked again.
    await expect(resolveLogo(UNI.toUpperCase().replace("0X", "0x"), d)).resolves.toEqual(miss);
    expect(d.readString).toHaveBeenCalledTimes(2);
    expect(d.fetchJson).toHaveBeenCalledTimes(1);

    // Past the hour the miss is retried.
    d.now.mockReturnValue(NOW + 3_600_001);
    await expect(resolveLogo(UNI, d)).resolves.toEqual(miss);
    expect(d.readString).toHaveBeenCalledTimes(4);
    expect(d.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("does not memoise a miss it could not verify", async () => {
    // The failure mode this guards: an RPC blip plus a DexScreener 429 used to be indistinguishable
    // from "no logo" and got cached as one for an hour, blanking a perfectly good logo.
    const d = deps({
      readString: vi.fn<LogoDeps["readString"]>(async () => ({ ok: false })),
      fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => {
        throw new Error("429 Too Many Requests");
      }),
    });
    await expect(resolveLogo(UNI, d)).resolves.toEqual({ logo: null, definite: false });
    expect(d.readString).toHaveBeenCalledTimes(2);
    expect(d.fetchJson).toHaveBeenCalledTimes(1);

    // Nothing was learned, so nothing is remembered: the very next call asks again.
    await expect(resolveLogo(UNI, d)).resolves.toEqual({ logo: null, definite: false });
    expect(d.readString).toHaveBeenCalledTimes(4);
    expect(d.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("still calls a miss definite when only one gateway of several failed", async () => {
    // A definite no must survive noise, or nothing would ever earn the hour.
    const d = deps({
      readString: answers("tokenURI", `ipfs://${CID}`),
      fetchJson: vi
        .fn<LogoDeps["fetchJson"]>()
        .mockRejectedValueOnce(new Error("gateway down"))
        .mockResolvedValueOnce({ name: "no image field here" })
        .mockResolvedValueOnce({ pairs: [] }),
    });
    await expect(resolveLogo(UNI, d)).resolves.toEqual({ logo: null, definite: true });
  });

  it("asks nothing once the budget is already gone", async () => {
    const d = deps({ fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [] })) });
    await expect(resolveLogo(UNI, d, NOW - 1)).resolves.toEqual({ logo: null, definite: false });
    expect(d.readString).not.toHaveBeenCalled();
    expect(d.fetchJson).not.toHaveBeenCalled();
  });

  it("gives each step what is left of the budget rather than a fresh timeout", async () => {
    const d = deps();
    await resolveLogo(UNI, d, NOW + 3_000);
    expect(d.readString.mock.calls[0]![2]).toBe(3_000); // 3s left, not the step's own 5s
  });

  it("memoises a hit for a day, keyed by the lowercased address", async () => {
    const d = deps({ readString: answers("logo", `ipfs://${CID}`) });
    const first = await resolveLogo(BABYHOOD, d);
    expect(d.readString).toHaveBeenCalledTimes(1);

    d.now.mockReturnValue(NOW + 23 * 3_600_000);
    await expect(resolveLogo(BABYHOOD.toUpperCase().replace("0X", "0x"), d)).resolves.toEqual(first);
    expect(d.readString).toHaveBeenCalledTimes(1);

    d.now.mockReturnValue(NOW + 24 * 3_600_000 + 1);
    await resolveLogo(BABYHOOD, d);
    expect(d.readString).toHaveBeenCalledTimes(2);
  });
});

describe("isAllowedLogoUrl", () => {
  it("accepts an ordinary https host, with or without an explicit 443", () => {
    expect(isAllowedLogoUrl("https://gateway.pinata.cloud/ipfs/bafy")).toBe(true);
    expect(isAllowedLogoUrl("https://dd.dexscreener.com:443/a.png")).toBe(true);
  });

  it("rejects everything that could reach something private", () => {
    // Logo URLs are chosen by the token contract, so each of these is a reachable attack.
    expect(isAllowedLogoUrl("http://dd.dexscreener.com/a.png")).toBe(false); // not https
    expect(isAllowedLogoUrl("https://169.254.169.254/latest/meta-data/")).toBe(false); // IPv4
    expect(isAllowedLogoUrl("https://127.0.0.1/a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://[::1]/a.png")).toBe(false); // IPv6 literal
    expect(isAllowedLogoUrl("https://localhost/a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://foo.internal/a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://printer.local/a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://api.localhost/a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://indexer.test:8080/a.png")).toBe(false); // non-443 port
  });

  it("is not fooled by a trailing root dot", () => {
    // "localhost." resolves exactly as "localhost", so one keystroke used to walk straight past
    // every check above.
    expect(isAllowedLogoUrl("https://localhost./a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://LOCALHOST./a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://foo.internal./a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://metadata.google.internal./x")).toBe(false);
    expect(isAllowedLogoUrl("https://printer.local../a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://gateway.pinata.cloud./ipfs/bafy")).toBe(true);
  });

  it("rejects other schemes and anything unparseable", () => {
    expect(isAllowedLogoUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedLogoUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    expect(isAllowedLogoUrl("ipfs://bafy")).toBe(false);
    expect(isAllowedLogoUrl("not a url")).toBe(false);
    expect(isAllowedLogoUrl("")).toBe(false);
  });

  it("normalises the numeric host forms that hide a loopback address", () => {
    // WHATWG parses these into 127.0.0.1, which is exactly why the check runs after parsing.
    expect(isAllowedLogoUrl("https://2130706433/a.png")).toBe(false);
    expect(isAllowedLogoUrl("https://0x7f.1/a.png")).toBe(false);
  });

  it("keeps a private host out of the gateway JSON fetch too", async () => {
    // A hostile tokenURI() is the same hole one layer up, so the resolver filters as well.
    const d = deps({
      readString: answers("tokenURI", "https://169.254.169.254/latest/meta-data/"),
      fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [] })),
    });
    // Definite, not unknown: a tokenURI pointing somewhere unfetchable is an answer about this
    // token, so it still earns the hour rather than being retried every request.
    await expect(resolveLogo(AI, d)).resolves.toEqual({ logo: null, definite: true });
    // The only call made is the DexScreener fallback; the metadata endpoint is never touched.
    expect(d.fetchJson.mock.calls.map((c) => c[0])).toEqual([`https://api.dexscreener.com/latest/dex/tokens/${AI}`]);
  });
});

describe("isAllowedImageType", () => {
  it("accepts the raster types, parameters and casing ignored", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(isAllowedImageType(t)).toBe(true);
    }
    expect(isAllowedImageType("image/PNG; charset=binary")).toBe(true);
    expect(isAllowedImageType(" image/webp ")).toBe(true);
  });

  it("normalises the type the route echoes back", () => {
    // The route must not forward `IMAGE/PNG; charset=binary` to the browser verbatim.
    expect(normaliseImageType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(normaliseImageType(" image/webp ")).toBe("image/webp");
    expect(normaliseImageType("image/svg+xml")).toBeNull();
    expect(normaliseImageType("")).toBeNull();
  });

  it("rejects svg and everything that is not an image", () => {
    // An SVG served from our own origin is a document that can run script; nosniff does not
    // help, because the type is declared honestly rather than sniffed.
    expect(isAllowedImageType("image/svg+xml")).toBe(false);
    expect(isAllowedImageType("image/svg+xml; charset=utf-8")).toBe(false);
    expect(isAllowedImageType("text/html")).toBe(false); // a gateway's rate-limit page
    expect(isAllowedImageType("application/json")).toBe(false);
    expect(isAllowedImageType("")).toBe(false);
  });
});

describe("memo bound", () => {
  it("evicts the oldest entry once the cap is reached", async () => {
    const d = deps({ fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [] })) });
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    for (let i = 0; i < 5000; i++) await resolveLogo(addr(i), d);
    const filled = d.readString.mock.calls.length;
    expect(filled).toBe(10_000); // two reads per miss, nothing served from the memo yet

    // Everything inserted is still remembered while the map is exactly full.
    await resolveLogo(addr(0), d);
    await resolveLogo(addr(4999), d);
    expect(d.readString).toHaveBeenCalledTimes(filled);

    // One more address pushes the queue along. Eviction is by insertion order, not by use, so
    // the victim is the oldest key and the newest is untouched.
    await resolveLogo(addr(5000), d);
    await resolveLogo(addr(4999), d);
    expect(d.readString).toHaveBeenCalledTimes(filled + 2); // 4999 survived, no new reads
    await resolveLogo(addr(0), d);
    expect(d.readString).toHaveBeenCalledTimes(filled + 4); // 0 was evicted and re-resolved
  });
});

describe("guardedFetch", () => {
  const init = () => ({ signal: AbortSignal.timeout(5_000), headers: { accept: "image/*" } });
  const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  const stubFetch = (mock: Mock<(url: string, init?: RequestInit) => Promise<Response>>) => {
    vi.stubGlobal("fetch", mock);
    return mock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a redirect that leaves the allowlist, without requesting it", async () => {
    // The attack this whole helper exists for: a permitted public host bouncing the server
    // onto the cloud metadata endpoint, which `redirect: "follow"` would have walked into.
    const f = stubFetch(vi.fn(async () => redirectTo("http://169.254.169.254/latest/meta-data/")));
    await expect(guardedFetch("https://gateway.pinata.cloud/ipfs/bafy", init())).resolves.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("https://gateway.pinata.cloud/ipfs/bafy");
    expect(f.mock.calls[0]![1]?.redirect).toBe("manual");
  });

  it("refuses a disallowed starting URL without fetching at all", async () => {
    const f = stubFetch(vi.fn(async () => new Response("x", { status: 200 })));
    await expect(guardedFetch("http://dd.dexscreener.com/a.png", init())).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("follows an allowed redirect and returns the terminal response", async () => {
    // w3s.link really does answer 301 to dweb.link, so this is the live shape of hop one.
    const f = stubFetch(
      vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(redirectTo("https://dweb.link/ipfs/bafy", 301))
        .mockResolvedValueOnce(new Response("bytes", { status: 200, headers: { "content-type": "image/png" } })),
    );
    const res = await guardedFetch("https://w3s.link/ipfs/bafy", init());
    expect(res?.status).toBe(200);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://w3s.link/ipfs/bafy", "https://dweb.link/ipfs/bafy"]);
  });

  it("resolves a relative Location against the current hop", async () => {
    const f = stubFetch(
      vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(redirectTo("/ipfs/other.png"))
        .mockResolvedValueOnce(new Response("bytes", { status: 200 })),
    );
    await guardedFetch("https://gateway.pinata.cloud/ipfs/bafy", init());
    expect(f.mock.calls[1]![0]).toBe("https://gateway.pinata.cloud/ipfs/other.png");
  });

  it("gives up rather than looping when the chain never ends", async () => {
    const f = stubFetch(vi.fn(async () => redirectTo("https://gateway.pinata.cloud/ipfs/next")));
    await expect(guardedFetch("https://gateway.pinata.cloud/ipfs/bafy", init())).resolves.toBeNull();
    expect(f).toHaveBeenCalledTimes(MAX_REDIRECTS + 1); // the first request plus its three hops
  });

  it("treats a redirect with no Location as a dead end", async () => {
    stubFetch(vi.fn(async () => new Response(null, { status: 302 })));
    await expect(guardedFetch("https://gateway.pinata.cloud/ipfs/bafy", init())).resolves.toBeNull();
  });

  it("hands back a non-ok response instead of swallowing it", async () => {
    // 404/429 is the caller's business: the image route drops the candidate, fetchJson throws.
    stubFetch(vi.fn(async () => new Response("nope", { status: 429 })));
    const res = await guardedFetch("https://gateway.pinata.cloud/ipfs/bafy", init());
    expect(res?.status).toBe(429);
  });
});

describe("resolveLogo: a launch made here (instant launchpad design, section 5.6)", () => {
  const SV = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
  const row = (o: Partial<{ imageCid: string; metadataUri: string; hidden: boolean }> = {}) =>
    vi.fn<LogoDeps["launchImage"]>(async () => ({ ok: true, row: { imageCid: IMAGE_CID, metadataUri: `ipfs://${CID}`, hidden: false, ...o } }));

  it("answers the launch's image on the Filebase gateway first, source launch, without asking the chain", async () => {
    const d = deps({ launchImage: row() });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: { candidates: gateways(IMAGE_CID), source: "launch" }, definite: true });
    expect(gateways(IMAGE_CID)[0]).toBe(`https://ipfs.filebase.io/ipfs/${IMAGE_CID}`);
    expect(d.readString).not.toHaveBeenCalled();
    expect(d.fetchJson).not.toHaveBeenCalled();
  });

  it("answers a definite no logo for a hidden launch, and never reaches DexScreener", async () => {
    const d = deps({ launchImage: row({ hidden: true }), fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [{ info: { imageUrl: "https://dd.dexscreener.com/a.png" } }] })) });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: null, definite: true });
    expect(d.fetchJson).not.toHaveBeenCalled();
    expect(d.readString).not.toHaveBeenCalled();
  });

  it("reads the metadata JSON's image when the launch has no image CID of its own", async () => {
    const d = deps({ launchImage: row({ imageCid: "" }), fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ image: `ipfs://${IMAGE_CID}` })) });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: { candidates: gateways(IMAGE_CID), source: "launch" }, definite: true });
    expect(d.fetchJson).toHaveBeenCalledWith(`https://ipfs.filebase.io/ipfs/${CID}`, 5000);
  });

  it("answers no logo, uncached, when the launch row cannot be read, without falling through to DexScreener", async () => {
    const launchImage = vi.fn<LogoDeps["launchImage"]>(async () => ({ ok: false }));
    const d = deps({ launchImage, fetchJson: vi.fn<LogoDeps["fetchJson"]>(async () => ({ pairs: [{ info: { imageUrl: "https://dd.dexscreener.com/a.png" } }] })) });
    await expect(resolveLogo(SV, d)).resolves.toEqual({ logo: null, definite: false });
    expect(d.fetchJson).not.toHaveBeenCalled();
    await resolveLogo(SV, d);
    expect(launchImage).toHaveBeenCalledTimes(2); // not memoised
  });

  it("holds a launch hit for one hour, not a day, so a takedown reaches everyone within the hour", async () => {
    const launchImage = row();
    const d = deps({ launchImage });
    await resolveLogo(SV, d);
    d.now.mockReturnValue(NOW + 59 * 60_000);
    await resolveLogo(SV, d);
    expect(launchImage).toHaveBeenCalledTimes(1);
    d.now.mockReturnValue(NOW + 60 * 60_000 + 1);
    await resolveLogo(SV, d);
    expect(launchImage).toHaveBeenCalledTimes(2);
  });

  it("falls through to the existing stages for a token not launched here", async () => {
    const d = deps({ readString: answers("logo", `ipfs://${CID}`) });
    await expect(resolveLogo(BABYHOOD, d)).resolves.toEqual({ logo: { candidates: gateways(CID), source: "pons" }, definite: true });
    expect(d.launchImage).toHaveBeenCalledWith(BABYHOOD);
  });
});
