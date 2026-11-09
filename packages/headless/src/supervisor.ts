// Process supervision (design §6.1.7): global handlers that log `fatal` and exit(1) (Docker
// `restart: unless-stopped` restarts the container), an internal watchdog (Docker does not restart an
// unhealthy container on its own), and SIGTERM/SIGINT shutdown within 15 s.

import type { Logger } from "./log";

export const SHUTDOWN_DEADLINE_MS = 15_000;
export const WATCHDOG_CHECK_MS = 30_000;

/** Pure stall decision: heartbeat older than stallSec and the loop not paused by a guard or the operator. */
export function isStalled(o: { now: number; heartbeatAt: number; stallSec: number; paused: boolean }): boolean {
  return !o.paused && o.now - o.heartbeatAt > o.stallSec * 1000;
}

export interface SupervisorOptions {
  log: Logger;
  exit?: (code: number) => void;
  stallSec: number;
  heartbeat: () => number;
  paused: () => boolean;
  now?: () => number;
  checkMs?: number;
  /** Graceful shutdown; must finish within SHUTDOWN_DEADLINE_MS or the process exits anyway. */
  shutdown: () => Promise<void>;
  /** Install process-level handlers (false in tests that run several daemons in one process). */
  installProcessHandlers?: boolean;
}

export class Supervisor {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly handlers: Array<[string, (...a: unknown[]) => void]> = [];

  constructor(private readonly o: SupervisorOptions) {}

  private exit(code: number): void {
    (this.o.exit ?? ((c: number) => process.exit(c)))(code);
  }

  start(): void {
    const now = this.o.now ?? Date.now;
    this.timer = setInterval(() => {
      try {
        if (isStalled({ now: now(), heartbeatAt: this.o.heartbeat(), stallSec: this.o.stallSec, paused: this.o.paused() })) {
          this.o.log.fatal("supervisor", "sync loop stalled", { stallSec: this.o.stallSec });
          void this.o.log.flush().finally(() => this.exit(1));
        }
      } catch {
        /* never throw from the watchdog */
      }
    }, this.o.checkMs ?? WATCHDOG_CHECK_MS);
    this.timer.unref();
    if (this.o.installProcessHandlers === false) return;
    const fatal = (kind: string) => (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.o.log.fatal("supervisor", kind, { err: `${e.name}: ${e.message}`, stack: e.stack?.split("\n").slice(0, 8).join(" | ") });
      void this.o.log.flush().finally(() => this.exit(1));
    };
    const signal = (sig: string) => () => { void this.terminate(sig); };
    this.on("unhandledRejection", fatal("unhandledRejection"));
    this.on("uncaughtException", fatal("uncaughtException"));
    this.on("SIGTERM", signal("SIGTERM"));
    this.on("SIGINT", signal("SIGINT"));
  }

  private on(ev: string, fn: (...a: unknown[]) => void): void {
    process.on(ev as "SIGTERM", fn as () => void);
    this.handlers.push([ev, fn]);
  }

  /** Graceful stop with a hard deadline (design §6.1.7: exit within 15 s). */
  async terminate(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.o.log.info("supervisor", `stopping (${reason})`);
    const deadline = setTimeout(() => {
      this.o.log.error("supervisor", "shutdown deadline passed; exiting");
      this.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      await this.o.shutdown();
      clearTimeout(deadline);
      await this.o.log.flush();
      this.exit(0);
    } catch (e) {
      clearTimeout(deadline);
      this.o.log.error("supervisor", "shutdown failed", { err: String(e) });
      this.exit(1);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [ev, fn] of this.handlers) process.off(ev as "SIGTERM", fn as () => void);
    this.handlers.length = 0;
  }
}
