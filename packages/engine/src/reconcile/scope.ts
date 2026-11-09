// Scope resolution seam. Part 3 implements PathFilter.scope(path, size?) (design §3.11); the engine
// core takes any function of this shape, so Planner/Reconciler/Scanner tests can use a stub.

import type { Scope } from "@shuttle/protocol";

export type ScopeFn = (path: string, size?: number) => Scope;

/** Everything active (tests). */
export const allActive: ScopeFn = () => "active";
