// Shared types for the spike probes (design §7.9, §10.2).
import type { App } from "obsidian";

export type Status = "pass" | "fail" | "info" | "skipped" | "error";

export interface ProbeOutcome {
  status: Status;
  summary: string;
  data?: Record<string, unknown>;
}

export interface ProbeResult extends ProbeOutcome {
  id: string;
  title: string;
  at: string;
  ms: number;
}

export interface SpikeSettings {
  serverUrl: string;
  /** Device token (sxd_…) or a one-time enroll code (SXE-…) for the real server; the code is swapped for a token. */
  serverToken: string;
  deviceName: string;
  m7IdleMinutes: number;
  postResults: boolean;
}

export interface Ctx {
  app: App;
  settings: SpikeSettings;
  /** True while "Run all safe probes" is running: probes must not prompt or open UI that blocks. */
  batch: boolean;
  /** Test-only folder inside the vault; every probe deletes what it creates there. */
  tmpDir: string;
  progress(msg: string): void;
  confirm(title: string, body: string): Promise<boolean>;
  ask(question: string, options: string[]): Promise<string | null>;
  ensureFolder(path: string): Promise<void>;
  /** Persists ctx.settings (the server probes store the device token an enroll code was swapped for). */
  saveSettings(): Promise<void>;
  /** Plugin-held state shared with lifecycle recorders registered at onload. */
  state: RecorderState;
}

export interface LifecycleEvent {
  t: number;
  type: string;
  detail?: string;
}

export interface RecorderState {
  lifecycle: LifecycleEvent[];
  rawEvents: { t: number; path: string }[];
  protocolHits: { t: number; action: string; params: Record<string, string> }[];
  previousSession: unknown;
  previousUnload: unknown;
  previousM12: unknown;
  loadedAt: number;
  /** Set by the M24 reload probe across a reload; read at onload. */
  reloadMarker: unknown;
  /** Hook the M23 probe uses to change the spike view's icon. */
  viewIcon: string;
}

export interface Probe {
  id: string;
  title: string;
  /** Included in "Run all safe probes". */
  safe: boolean;
  /** Heavy or destructive: requires the confirm modal. */
  confirm?: string;
  needsServer?: boolean;
  run(ctx: Ctx): Promise<ProbeOutcome>;
}
