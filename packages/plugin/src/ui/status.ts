// Status icon state (design §5.2.1): derived from engine.status() plus plugin conditions. Pure.

import type { EngineStatus } from "@shuttle/protocol";
import { t } from "../i18n";

export type UiState = "notConfigured" | "locked" | "error" | "disconnected" | "paused" | "syncing" | "synced";

export interface UiInput {
  configured: boolean;
  /** Engine status, null before the engine started. */
  status: EngineStatus | null;
  /** Key cache missing and the engine not started (row 2). */
  keysMissing: boolean;
  /** An unanswered guard is open (tooltip variant). */
  guardOpen: boolean;
}

export interface UiView { state: UiState; icon: string; colorVar: string; tooltip: string; spin: boolean }

const ICON: Record<UiState, [string, string]> = {
  notConfigured: ["cloud-off", "--text-muted"],
  locked: ["lock", "--color-orange"],
  error: ["circle-alert", "--color-red"],
  disconnected: ["circle-slash", "--color-red"],
  paused: ["circle-pause", "--color-purple"],
  syncing: ["refresh-cw", "--color-purple"],
  synced: ["circle-check", "--color-green"],
};

/** First match wins, in the §5.2.1 priority order. */
export function deriveUiState(i: UiInput): UiState {
  if (!i.configured) return "notConfigured";
  const s = i.status;
  if (i.keysMissing && !s) return "locked";
  if (s?.locked) return "locked";
  if (!s) return "disconnected";
  if (s.status === "error") return "error";
  if (s.status === "disconnected") return "disconnected";
  if (s.status === "paused") return "paused";
  if (s.status === "syncing") return "syncing";
  return "synced";
}

/** Human reason for `error` / `disconnected` from the engine's machine-readable reason. */
export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case undefined: case "": return t("reason.unreachable");
    case "NETWORK": case "TIMEOUT": case "offline": return t("reason.unreachable");
    case "UNAUTHENTICATED": return "Not logged in";
    case "REVOKED": return "This device was removed from the server";
    case "FORBIDDEN": return "Access denied";
    case "VAULT_NOT_FOUND": return "Vault not found";
    case "QUOTA": return "The remote vault is full";
    case "tampered": return t("guard.tampered.title");
    case "selfTest": return t("log.selfTestFailed");
    default: return reason;
  }
}

export function uiView(i: UiInput): UiView {
  const state = deriveUiState(i);
  const [icon, colorVar] = ICON[state];
  const s = i.status;
  let tooltip: string;
  switch (state) {
    case "notConfigured": tooltip = t("status.notConfigured"); break;
    case "locked": tooltip = t("status.locked"); break;
    case "error": tooltip = t("status.error", { reason: reasonText(s?.reason) }); break;
    case "disconnected": tooltip = t("status.disconnected", { reason: reasonText(s?.reason) }); break;
    case "paused": tooltip = i.guardOpen ? t("status.pausedGuard") : t("status.paused"); break;
    case "syncing": tooltip = t("status.syncing", { up: s?.pendingUp ?? 0, down: s?.pendingDown ?? 0 }); break;
    default: tooltip = t("status.synced");
  }
  return { state, icon, colorVar, tooltip, spin: state === "syncing" };
}

/**
 * design §5.2.1: `syncing` is shown only after work lasts > 400 ms; the way back to `synced` is
 * immediate. Feed it every derived state; it calls `show` with the state to display.
 */
export class SyncingDebounce {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shown: UiState | null = null;
  constructor(private readonly delayMs: number, private readonly show: (s: UiState) => void,
    private readonly timers: { set(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clear(h: ReturnType<typeof setTimeout>): void } = {
      set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h),
    }) {}

  push(s: UiState): void {
    if (s === "syncing") {
      if (this.shown === "syncing" || this.timer) return;
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.set("syncing");
      }, this.delayMs);
      return;
    }
    if (this.timer) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    this.set(s);
  }

  private set(s: UiState): void {
    if (this.shown === s) return;
    this.shown = s;
    this.show(s);
  }

  dispose(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }
}
