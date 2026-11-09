// Safety guards (design §3.13, engine-spec §12). The thresholds are pure functions; GuardBoard keeps
// the unanswered guard events and routes engine.answerGuard(id, choice) back to whoever raised them.

import type { GuardChoice, GuardEvent, GuardKind } from "@shuttle/protocol";
import { MASS_DELETE_FRACTION, MASS_DELETE_MIN } from "../apply/RemoteApplier";

/** Mass delete: more than max(25, 10 % of active files) in one loop (design §3.13, §3.8.3); constants shared with the pull guard. */
/** Empty vault: index has at least this many active files... */
export const EMPTY_VAULT_MIN_INDEXED = 20;
/** ...and the scan sees none, or fewer than this fraction of them. */
export const EMPTY_VAULT_FRACTION = 0.1;
/** Rebuild or pairing would create more than this many conflict copies. */
export const MASS_CONFLICT_MAX = 20;
/** Epoch change touching more than this many files raises the informational `epoch` guard. */
export const EPOCH_INFO_MIN = 100;
/** Paths listed in a guard event. */
export const GUARD_SAMPLE = 10;

export function massDeleteThreshold(activeFiles: number): number {
  return Math.max(MASS_DELETE_MIN, Math.floor(activeFiles * MASS_DELETE_FRACTION));
}

/** design §3.13 emptyVault condition. */
export function looksEmpty(seen: number, indexedActive: number): boolean {
  if (indexedActive < EMPTY_VAULT_MIN_INDEXED) return false;
  return seen === 0 || seen < indexedActive * EMPTY_VAULT_FRACTION;
}

/** Choices that make sense per kind (others are treated as 'pause'). */
export const GUARD_CHOICES: Readonly<Record<GuardKind, readonly GuardChoice[]>> = Object.freeze({
  emptyVault: ["apply", "pause"],
  massDeleteLocal: ["apply", "pause"],
  massDeleteRemote: ["apply", "pause"],
  massConflict: ["apply", "pause"],
  rollback: ["accept", "rebuild", "pause"],
  tampered: ["pause"],
  integrity: ["pause"],
  epoch: ["pause"],
});

/** Guards that stop the loop until answered. `integrity` holds files, `epoch` is informational. */
export const PAUSING_GUARDS: ReadonlySet<GuardKind> = new Set<GuardKind>([
  "emptyVault", "massDeleteLocal", "massDeleteRemote", "massConflict", "rollback", "tampered",
]);

export interface OpenGuard extends GuardEvent { raisedAt: number }

export class GuardBoard {
  private open = new Map<string, OpenGuard>();
  private seq = 0;

  constructor(private readonly now: () => number, private readonly emit: (g: GuardEvent) => void) {}

  /** Raise a guard; an unanswered one of the same kind is updated in place and not emitted again. */
  raise(kind: GuardKind, n: number, sample: readonly string[]): OpenGuard {
    for (const g of this.open.values()) {
      if (g.kind !== kind) continue;
      g.n = n;
      g.sample = sample.slice(0, GUARD_SAMPLE);
      return g;
    }
    const g: OpenGuard = { id: `g${++this.seq}-${kind}`, kind, n, sample: sample.slice(0, GUARD_SAMPLE), raisedAt: this.now() };
    this.open.set(g.id, g);
    this.emit({ id: g.id, kind: g.kind, n: g.n, sample: [...g.sample] });
    return g;
  }

  /** Remove and return the guard, normalizing a choice the kind does not offer to 'pause'. */
  take(id: string, choice: GuardChoice): { g: OpenGuard; choice: GuardChoice } | null {
    const g = this.open.get(id);
    if (!g) return null;
    this.open.delete(id);
    return { g, choice: GUARD_CHOICES[g.kind].includes(choice) ? choice : "pause" };
  }

  has(kind: GuardKind): boolean {
    for (const g of this.open.values()) if (g.kind === kind) return true;
    return false;
  }

  clear(kind: GuardKind): void {
    for (const [id, g] of this.open) if (g.kind === kind) this.open.delete(id);
  }

  list(): OpenGuard[] {
    return [...this.open.values()].map((g) => ({ ...g, sample: [...g.sample] }));
  }
}
