import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTtlCache } from "@/lib/envio/cache";
import type { HealthReport } from "@/lib/market/backend";
import { GET } from "./route";

// The backend is the seam: the route only memoises its outcome and picks the status.
const { health } = vi.hoisted(() => ({ health: vi.fn<() => Promise<HealthReport>>() }));
vi.mock("@/lib/market/backend", () => ({ getBackend: () => ({ kind: "envio", health }) }));

const NOW_SEC = 1_789_547_000;
const healthy: HealthReport = { ok: true, backend: "envio", lag: 0, quotes: [{ id: "0xquote", ageSec: 60, stale: false }] };
const down: HealthReport = { ok: false, backend: "envio", lag: null, quotes: [], error: "indexer unavailable" };

describe("GET /api/health", () => {
  beforeEach(() => {
    clearTtlCache();
    health.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers 503 no-store when the backend reports not ok", async () => {
    health.mockResolvedValue(down);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual(down);
  });

  it("caches the outcome for the window instead of re-asking on every request", async () => {
    health.mockResolvedValue(down);
    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(503);
    // The point of Ruling 23: an outage must not cost one probe per request.
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with the report while healthy", async () => {
    health.mockResolvedValue(healthy);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(healthy);
  });

  it("re-asks once the window expires and reports the new outcome", async () => {
    health.mockResolvedValue(healthy);
    expect((await GET()).status).toBe(200);
    health.mockResolvedValue(down);
    expect((await GET()).status).toBe(200); // inside the window: nothing asked
    vi.advanceTimersByTime(6_000);
    expect((await GET()).status).toBe(503);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("turns a throwing backend into a 503 without caching an exception", async () => {
    health.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, backend: "envio", lag: null, quotes: [], error: "health check failed" });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
