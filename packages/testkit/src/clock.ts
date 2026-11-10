// Deterministic Clock and Scheduler (design §3.14, §3.15; ops-spec §3 SimDevice).
// FakeClock: monotonic time only moves when the test advances it. Wall time = base + offset + drift,
// so simulated devices can disagree about wall time (ops-spec: ±36 h offset, ±0.1 % drift).
// FakeScheduler: timers fire only from advance()/runAll(), in (due time, creation order).

import type { Clock, Scheduler, TimerHandle } from "@shuttle/protocol";

import { macrotask } from "./macrotask";

/** Resolve after every queued microtask (and microtasks they queue) has run. */
export function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => { macrotask(() => resolve()); });
}

export interface FakeClockOptions {
  /** Wall-clock value at monotonic 0. Default 2026-01-01T00:00:00Z. */
  start?: number;
  /** Fixed wall-clock offset in ms (clock skew). */
  offsetMs?: number;
  /** Relative drift, e.g. 0.001 = wall time runs 0.1 % fast. */
  drift?: number;
}

export const FAKE_EPOCH = Date.UTC(2026, 0, 1);

export class FakeClock implements Clock {
  private mono = 0;
  private readonly start: number;
  offsetMs: number;
  drift: number;

  constructor(o: FakeClockOptions = {}) {
    this.start = o.start ?? FAKE_EPOCH;
    this.offsetMs = o.offsetMs ?? 0;
    this.drift = o.drift ?? 0;
  }

  now(): number {
    return Math.floor(this.start + this.offsetMs + this.mono * (1 + this.drift));
  }

  monotonic(): number {
    return this.mono;
  }

  /** Move time forward without running timers (use FakeScheduler.advance to run them). */
  tick(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`tick(ms): ms must be >= 0, got ${ms}`);
    this.mono += ms;
  }

  /** A clock that shares this clock's monotonic time but has its own wall offset and drift. */
  skewed(o: { offsetMs?: number; drift?: number }): Clock {
    const self = this;
    const offsetMs = o.offsetMs ?? 0;
    const drift = o.drift ?? 0;
    return {
      now: () => Math.floor(self.start + self.offsetMs + offsetMs + self.mono * (1 + self.drift + drift)),
      monotonic: () => self.mono,
    };
  }
}

interface Timer { id: number; due: number; order: number; fn: () => void }

export class FakeScheduler implements Scheduler {
  readonly clock: FakeClock;
  private timers = new Map<number, Timer>();
  private nextId = 1;
  private order = 0;
  /** Counters for performance assertions (design §7.2 I23). */
  readonly stats = { yields: 0, idles: 0, timersSet: 0, timersFired: 0 };
  /** Errors thrown by timer callbacks; tests should assert this stays empty. */
  readonly errors: unknown[] = [];

  constructor(clock: FakeClock = new FakeClock()) {
    this.clock = clock;
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.clock.monotonic() + Math.max(0, ms), order: this.order++, fn });
    this.stats.timersSet++;
    return id;
  }

  clearTimer(h: TimerHandle): void {
    this.timers.delete(h);
  }

  yieldToUi(): Promise<void> {
    this.stats.yields++;
    return Promise.resolve();
  }

  idle(_timeoutMs?: number): Promise<void> {
    this.stats.idles++;
    return Promise.resolve();
  }

  /** Number of pending timers. */
  get pending(): number {
    return this.timers.size;
  }

  /** Monotonic due time of the next timer, or null. */
  nextDue(): number | null {
    const t = this.peek();
    return t ? t.due : null;
  }

  private peek(): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers.values()) {
      if (!best || t.due < best.due || (t.due === best.due && t.order < best.order)) best = t;
    }
    return best;
  }

  private fire(t: Timer): void {
    this.timers.delete(t.id);
    this.stats.timersFired++;
    try {
      t.fn();
    } catch (e) {
      this.errors.push(e);
    }
  }

  /**
   * Advance time by `ms`, firing due timers in order. The clock steps to each timer's due time before
   * it fires, and microtasks are drained after each timer, so async continuations run "at" that time.
   */
  async advance(ms: number): Promise<void> {
    const target = this.clock.monotonic() + ms;
    await drainMicrotasks();
    for (;;) {
      const t = this.peek();
      if (!t || t.due > target) break;
      if (t.due > this.clock.monotonic()) this.clock.tick(t.due - this.clock.monotonic());
      this.fire(t);
      await drainMicrotasks();
    }
    if (target > this.clock.monotonic()) this.clock.tick(target - this.clock.monotonic());
    await drainMicrotasks();
  }

  /** Fire timers until none are left (or `maxTimers` fired, to catch runaway rescheduling). */
  async runAll(maxTimers = 10_000): Promise<void> {
    await drainMicrotasks();
    for (let n = 0; ; n++) {
      const t = this.peek();
      if (!t) return;
      if (n >= maxTimers) throw new Error(`FakeScheduler.runAll: more than ${maxTimers} timers fired`);
      if (t.due > this.clock.monotonic()) this.clock.tick(t.due - this.clock.monotonic());
      this.fire(t);
      await drainMicrotasks();
    }
  }
}
