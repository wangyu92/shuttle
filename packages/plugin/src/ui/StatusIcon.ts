// Status icon (design §5.2.1, UX-D4): a status bar item on desktop, a ribbon icon on mobile
// (`addStatusBarItem` is not available there). Colors come from CSS variables in styles.css, keyed by
// `data-state`; the spin respects prefers-reduced-motion there too.

import { setIcon } from "obsidian";
import { SYNCING_SHOW_DELAY_MS } from "../constants";
import { SyncingDebounce, type UiState, type UiView } from "./status";

export class StatusIcon {
  private shown: UiState | null = null;
  private latest: UiView | null = null;
  private readonly debounce: SyncingDebounce;

  constructor(readonly el: HTMLElement) {
    el.addClass("shuttle-status-icon");
    el.setAttr("aria-live", "polite");
    this.debounce = new SyncingDebounce(SYNCING_SHOW_DELAY_MS, (s) => {
      this.shown = s;
      if (this.latest) this.paint(this.latest);
    });
  }

  /** Called on every status change; `syncing` appears only after 400 ms (design §5.2.1). */
  render(v: UiView): void {
    this.latest = v;
    if (v.state === this.shown) {
      this.paint(v);
      return;
    }
    this.debounce.push(v.state);
  }

  private paint(v: UiView): void {
    // While waiting out the syncing delay the previous state stays on screen with its own text.
    if (v.state !== this.shown) return;
    if (this.el.getAttr("data-state") !== v.state) {
      this.el.empty();
      setIcon(this.el, v.icon);
      this.el.setAttr("data-state", v.state);
    }
    this.el.setAttr("aria-label", v.tooltip);
    this.el.setAttr("title", v.tooltip);
  }

  dispose(): void {
    this.debounce.dispose();
  }
}
