// Clock and Scheduler on the host's timers (design §3.14, §3.15), with one dispose() that clears every
// pending timer so unloading the plugin leaves nothing running (design §5.11 resource cleanup).

import type { Clock, Scheduler, TimerHandle } from "@shuttle/protocol";

export const pluginClock: Clock = {
  now: () => Date.now(),
  monotonic: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

type IdleFn = (cb: () => void, o?: { timeout: number }) => number;

export class PluginScheduler implements Scheduler {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private next = 1;
  private disposed = false;

  setTimer(ms: number, fn: () => void): TimerHandle {
    const id = this.next++;
    if (this.disposed) return id;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, Math.max(0, ms)));
    return id;
  }

  clearTimer(h: TimerHandle): void {
    const t = this.timers.get(h);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(h);
    }
  }

  yieldToUi(): Promise<void> {
    const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (s && typeof s.yield === "function") return s.yield();
    return new Promise<void>((r) => setTimeout(r, 0));
  }

  idle(timeoutMs = 0): Promise<void> {
    const ric = (globalThis as { requestIdleCallback?: IdleFn }).requestIdleCallback;
    if (typeof ric === "function") return new Promise<void>((r) => { ric(() => r(), { timeout: Math.max(1, timeoutMs) }); });
    return new Promise<void>((r) => setTimeout(r, Math.min(timeoutMs, 50)));
  }

  /** Pending timers (tests). */
  get pending(): number {
    return this.timers.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
