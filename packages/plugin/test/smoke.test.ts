// The plugin entry loads against the obsidian stub, registers its surfaces without I/O, keeps
// data.json to {schema: 1}, and unloads cleanly (design §5.10, §5.11, UX-D6).
import { describe, expect, it } from "vitest";
import ShuttlePlugin, { PACKAGE_NAME } from "../src/index";
import type { FakeEl } from "./obsidian-stub";

function fakeApp() {
  const ls = new Map<string, unknown>();
  let layoutCb: (() => void) | null = null;
  return {
    ls,
    runLayout: () => layoutCb?.(),
    app: {
      workspace: { onLayoutReady: (cb: () => void) => { layoutCb = cb; } },
      loadLocalStorage: (k: string) => ls.get(k) ?? null,
      saveLocalStorage: (k: string, v: unknown) => { if (v === null) ls.delete(k); else ls.set(k, v); },
      vault: { configDir: ".obsidian", getName: () => "Notes" },
    },
  };
}

describe("shuttle (plugin)", () => {
  it("loads its entry", () => {
    expect(PACKAGE_NAME).toBe("shuttle");
    expect(typeof ShuttlePlugin).toBe("function");
  });

  it("onload registers the status icon, commands, settings tab and protocol handlers; data.json stays {schema:1}", async () => {
    const f = fakeApp();
    const p = new ShuttlePlugin(f.app as never, { id: "shuttle" } as never) as unknown as ShuttlePlugin & {
      commands: Array<{ id: string }>; statusBar: FakeEl[]; settingTabs: unknown[]; protocolHandlers: Map<string, unknown>; data: unknown;
    };
    p.data = { schema: 1, token: "sxd_should_be_dropped" };
    await p.onload();
    expect(p.data).toEqual({ schema: 1, token: "sxd_should_be_dropped" }); // no file I/O before layout-ready
    expect(p.commands.map((c) => c.id)).toEqual(expect.arrayContaining(["open-log", "pause", "resume", "toggle-pause", "sync-now", "set-up", "unlock", "copy-debug", "add-device"]));
    expect(p.settingTabs).toHaveLength(1);
    expect([...p.protocolHandlers.keys()].sort()).toEqual(["shuttle-enroll", "shuttle-pair"]);
    const icon = p.statusBar[0]!;
    expect(icon.getAttr("data-state")).toBe("notConfigured");
    expect(icon.icon).toBe("cloud-off");
    expect(f.ls.size).toBe(0); // nothing written before layout-ready
    p.onunload();
    expect(p.data).toEqual({ schema: 1, token: "sxd_should_be_dropped" });
  });

  it("after layout-ready: data.json is reset to {schema:1} and the welcome notice shows once", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g["document"], window: g["window"] };
    g["document"] = { visibilityState: "visible" };
    g["window"] = { WebSocket: class {} };
    try {
      const { Notice } = await import("./obsidian-stub");
      const f = fakeApp();
      const p = new ShuttlePlugin(f.app as never, { id: "shuttle" } as never) as unknown as ShuttlePlugin & { data: unknown };
      p.data = { schema: 1, token: "sxd_should_be_dropped" };
      await p.onload();
      Notice.shown.length = 0;
      f.runLayout();
      for (let i = 0; i < 20 && Notice.shown.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(p.data).toEqual({ schema: 1 });
      expect(Notice.shown).toEqual(["SHUTTLE is installed. Open its settings to connect a remote vault."]);
      expect(f.ls.get("shuttle:v1:welcomed")).toBe(true);
      p.onunload();
    } finally {
      g["document"] = saved.document;
      g["window"] = saved.window;
    }
  });
});
