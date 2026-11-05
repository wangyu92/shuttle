// Small helpers. Browser APIs only (no node:* imports, see testkit/depRules.test.ts).

export const KiB = 1024;
export const MiB = 1024 * 1024;

export const now = (): number => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function toHex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i++) s += u[i]!.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64u(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** getRandomValues is capped at 65536 bytes per call. */
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
}

export async function sha256hex(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    }),
  ]);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
}

/**
 * Main-thread blocking monitor (P0-C11). PerformanceObserver "longtask" is missing on WebKit,
 * so a 16 ms interval measures the largest gap between ticks as the fallback.
 */
export class GapMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private last = 0;
  private maxGap = 0;
  private obs: PerformanceObserver | undefined;
  private longTasks: number[] = [];
  readonly longtaskSupported: boolean;

  constructor() {
    const types = (globalThis.PerformanceObserver as unknown as { supportedEntryTypes?: string[] } | undefined)
      ?.supportedEntryTypes;
    this.longtaskSupported = Array.isArray(types) && types.includes("longtask");
  }

  start(): void {
    this.last = now();
    this.maxGap = 0;
    this.longTasks = [];
    this.timer = setInterval(() => {
      const t = now();
      this.maxGap = Math.max(this.maxGap, t - this.last);
      this.last = t;
    }, 16);
    if (this.longtaskSupported) {
      try {
        this.obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) this.longTasks.push(e.duration);
        });
        this.obs.observe({ entryTypes: ["longtask"] });
      } catch {
        this.obs = undefined;
      }
    }
  }

  /** Lets the interval fire once more so a block at the very end is counted. */
  async stop(): Promise<{ maxGapMs: number; longtaskSupported: boolean; longTasks: number; maxLongTaskMs: number }> {
    await sleep(40);
    clearInterval(this.timer);
    this.obs?.disconnect();
    return {
      maxGapMs: round(this.maxGap),
      longtaskSupported: this.longtaskSupported,
      longTasks: this.longTasks.length,
      maxLongTaskMs: round(this.longTasks.reduce((a, b) => Math.max(a, b), 0)),
    };
  }
}

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9가-힣_-]+/g, "-").replace(/^-+|-+$/g, "") || "device";
}

export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
