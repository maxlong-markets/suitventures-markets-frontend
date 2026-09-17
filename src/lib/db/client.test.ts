import { afterEach, describe, expect, it, vi } from "vitest";
import { DbUnavailableError, createDb, getDb, resetDb } from "./client";

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
