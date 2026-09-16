import type { Address, VoteDir } from "@/lib/types";

function key(kind: "watch" | "votes", address: Address): string {
  return `svm:${kind}:${address.toLowerCase()}`;
}
function read<T>(k: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(k: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(k, JSON.stringify(value));
  } catch {
    // private mode or quota: the session keeps working without persistence
  }
}

/** Browser-local watchlist and votes until the signed API exists (M2). */
export class LocalWatchStore {
  watchlist(address: Address): string[] {
    return read<string[]>(key("watch", address), []);
  }
  setWatch(address: Address, id: string, on: boolean): void {
    const list = this.watchlist(address).filter((x) => x !== id);
    write(key("watch", address), on ? [...list, id] : list);
  }
  votes(address: Address): Record<string, VoteDir> {
    return read<Record<string, VoteDir>>(key("votes", address), {});
  }
  vote(address: Address, id: string, dir: VoteDir): void {
    const book = this.votes(address);
    if (book[id] === dir) delete book[id];
    else book[id] = dir;
    write(key("votes", address), book);
  }
}
