// One macrotask hop for the fakes (design §7.4: a failing seed replays bit for bit).
// The fakes defer sink callbacks and microtask drains by one macrotask. By default that is a real
// setTimeout(0). A simulator that needs a total order between these hops and other asynchronous
// completions (WebCrypto runs on a thread pool) installs a hook that queues them itself.

// Captured at load so tests that install fake global timers do not freeze our macrotask drain.
const realSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis);

export type MacrotaskHook = (fn: () => void) => void;

let hook: MacrotaskHook | null = null;

/** Run `fn` in a later macrotask (through the installed hook, if any). */
export function macrotask(fn: () => void): void {
  if (hook) hook(fn);
  else realSetTimeout(fn, 0);
}

/** Install (or clear with null) the macrotask hook; returns the previous one. */
export function setMacrotaskHook(h: MacrotaskHook | null): MacrotaskHook | null {
  const prev = hook;
  hook = h;
  return prev;
}
