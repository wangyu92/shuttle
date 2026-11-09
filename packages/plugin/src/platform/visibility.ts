// Foreground / background hooks (design §3.14, §5.10). P0 M9 on iOS: app switch and lock fire
// `visibilitychange` (hidden/visible), `resume`, `blur`/`focus`, never `pagehide`; M21: a force-quit
// ends the session without `onunload`. So `visibilitychange` is the source of truth, `resume` and
// `focus` only confirm "visible" (the engine ignores repeats), and nothing waits for unload.

export interface DomEventRegistrar {
  (target: Document | Window, type: string, cb: () => void): void;
}

export function registerVisibilityHooks(
  register: DomEventRegistrar, doc: Document, win: Window, onVisibility: (visible: boolean) => void,
): void {
  register(doc, "visibilitychange", () => onVisibility(doc.visibilityState !== "hidden"));
  register(doc, "resume", () => onVisibility(true));
  register(doc, "pause", () => onVisibility(false));
  register(win, "focus", () => { if (doc.visibilityState !== "hidden") onVisibility(true); });
}
