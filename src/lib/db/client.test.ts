import { afterEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError, createDb, getDb, resetDb, unavailableCode } from "./client";

/** No connection is ever opened here: the value fails URL parsing before the driver reaches the network. */
const MALFORMED = "postgres://user:sup3rSecret@";

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected fn to throw");
}

function expectGuarded(err: unknown): void {
  expect(err).toBeInstanceOf(DbUnavailableError);
  expect((err as Error).name).toBe("DbUnavailableError");
  expect((err as Error).message).toBe("DATABASE_URL is not a valid connection string");
  expect((err as Error).message).not.toContain("sup3rSecret");
  expect(err).not.toHaveProperty("input");
  expect(err).not.toHaveProperty("cause");
}

describe("createDb", () => {
  it("rethrows a malformed connection string as DbUnavailableError with nothing from the input attached", () => {
    // Node's URL parser puts the whole string on its TypeError as `input`; that must never reach a log.
    expectGuarded(caught(() => createDb(MALFORMED)));
  });
});

describe("unavailableCode", () => {
  it.each([
    // sockets and DNS
    "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED",
    // TLS to the pooler
    "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
    // the driver's own
    "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
    // SQLSTATE: connection, resources, admin shutdown, Supavisor's "max client connections reached"
    "08006", "08001", "53300", "57P01", "XX000",
  ])("treats %s as the database being unavailable", (code) => {
    expect(unavailableCode(Object.assign(new Error("driver text with the host in it"), { code }))).toBe(code);
  });
  it.each(["42P01", "23505", "22P02", "57014"])("leaves %s (a query's own error) to the caller", (code) => {
    expect(unavailableCode(Object.assign(new Error("x"), { code }))).toBeNull();
  });
  it("answers null without a string code", () => {
    expect(unavailableCode(new Error("x"))).toBeNull();
    expect(unavailableCode({ code: 42 })).toBeNull();
    expect(unavailableCode(null)).toBeNull();
  });
});

describe("getDb", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetDb();
  });

  it("inherits the guard when DATABASE_URL is malformed", () => {
    vi.stubEnv("DATABASE_URL", MALFORMED);
    resetDb();
    expectGuarded(caught(() => getDb()));
  });
});
