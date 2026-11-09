// Expected-write registry (design §3.6.2; engine-spec §3.6). Before any engine write, rename or delete
// the executor calls expect(); a later event or scan that observes exactly that state consumes it and
// only updates `obs`. Matching compares hash and size only (processText cannot set mtime).
// Correctness never depends on this: an unmatched echo resolves to row S1 because the apply
// transaction already set synced.hash == obs.hash. It only saves hashing and planning.

import type { Clock } from "@shuttle/protocol";
import { ECHO_TTL_MS } from "./timing";

export type EchoExpectation = { hash: string; size: number } | 'deleted' | { renamedFrom: string };
export type EchoObservation = { hash: string; size: number } | 'deleted' | { renamedFrom: string };

interface Entry { exp: EchoExpectation; until: number }

export class EchoSuppressor {
  private m = new Map<string, Entry[]>();
  constructor(private readonly clock: Pick<Clock, "monotonic">, private readonly ttlMs = ECHO_TTL_MS) {}

  expect(path: string, exp: EchoExpectation): void {
    const list = this.live(path);
    list.push({ exp, until: this.clock.monotonic() + this.ttlMs });
    this.m.set(path, list);
  }

  /** True (and the expectation is removed) when `obs` matches an unexpired expectation for `path`. */
  consume(path: string, obs: EchoObservation): boolean {
    const list = this.live(path);
    const i = list.findIndex((x) => matches(x.exp, obs));
    if (i < 0) {
      if (list.length) this.m.set(path, list); else this.m.delete(path);
      return false;
    }
    list.splice(i, 1);
    if (list.length) this.m.set(path, list); else this.m.delete(path);
    return true;
  }

  /** Whether any unexpired expectation exists for `path` (tests, debug). */
  pending(path: string): boolean {
    return this.live(path).length > 0;
  }

  clear(): void {
    this.m.clear();
  }

  private live(path: string): Entry[] {
    const now = this.clock.monotonic();
    return (this.m.get(path) ?? []).filter((x) => x.until > now);
  }
}

function matches(e: EchoExpectation, o: EchoObservation): boolean {
  if (e === "deleted" || o === "deleted") return e === o;
  if ("renamedFrom" in e || "renamedFrom" in o) return "renamedFrom" in e && "renamedFrom" in o && e.renamedFrom === o.renamedFrom;
  return e.hash === o.hash && e.size === o.size;
}
