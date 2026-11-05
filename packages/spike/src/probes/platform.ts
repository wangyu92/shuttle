// Platform probes: M8 (wrapper), M9, M19, M20, M21, M23, M24. Several are recorders: listeners are
// registered at onload (index.ts) and the probe reports what they saw.
import type { App, WorkspaceLeaf } from "obsidian";
import { setIcon } from "obsidian";
import type { Ctx, Probe, ProbeOutcome } from "../types.js";
import { errMsg, sleep } from "../util.js";
import { computeGolden, DMP_CASES, type DmpGolden } from "./dmp-cases.js";
import GOLDENS from "./dmp-goldens.json" with { type: "json" };
import type { M8Recorder } from "./server.js";

export interface PlatformHooks {
  openSpikeView(): Promise<WorkspaceLeaf>;
  ribbonEl(): HTMLElement | null;
  m8: M8Recorder;
  /** Records an outcome that arrives later (M8 after returning from background). */
  recordLater(id: string, title: string, o: ProbeOutcome): void;
  /** Persists a marker the next onload reads (M24 reload). */
  setReloadMarker(v: unknown): Promise<void>;
  enrollUri(): string;
}

type AppPrivate = App & {
  setting?: { open?: () => void; openTabById?: (id: string) => unknown; close?: () => void };
  commands?: { executeCommandById?: (id: string) => boolean; commands?: Record<string, unknown> };
};

export function platformProbes(h: PlatformHooks): Probe[] {
  return [
    {
      id: "M8",
      title: "Return from background: socket closed after 5 s, reconnect",
      safe: false,
      needsServer: true,
      async run(ctx): Promise<ProbeOutcome> {
        const msg = await h.m8.arm(ctx, (o) => h.recordLater("M8", "Return from background: socket closed after 5 s, reconnect", o));
        return { status: "info", summary: `${msg}; the result row is replaced when you return`, data: { armed: h.m8.armed } };
      },
    },
    {
      id: "M9",
      title: "visibilitychange / pagehide on app switch, lock, return",
      safe: true,
      async run(ctx): Promise<ProbeOutcome> {
        const ev = ctx.state.lifecycle;
        const seen = (t: string) => ev.some((e) => e.type === t);
        const counts: Record<string, number> = {};
        for (const e of ev) {
          const k = e.detail ? `${e.type}:${e.detail}` : e.type;
          counts[k] = (counts[k] ?? 0) + 1;
        }
        const ok = ev.some((e) => e.type === "visibilitychange" && e.detail === "hidden") &&
          ev.some((e) => e.type === "visibilitychange" && e.detail === "visible") && seen("pagehide");
        return {
          status: ok ? "pass" : "info",
          summary: ev.length
            ? `since load: ${Object.entries(counts).map(([k, v]) => `${k}x${v}`).join(", ")}${seen("pagehide") ? "" : " (no pagehide yet)"}`
            : "no lifecycle events yet: switch apps, lock the screen, come back, then re-run",
          data: { counts, events: ev.slice(-100) },
        };
      },
    },
    {
      id: "M19",
      title: "obsidian://shuttle-enroll and shuttle-pair handlers",
      safe: true,
      async run(ctx): Promise<ProbeOutcome> {
        const hits = ctx.state.protocolHits;
        const uri = h.enrollUri();
        if (!ctx.batch) {
          try {
            await navigator.clipboard.writeText(uri);
          } catch {
            /* the link is also in the results note */
          }
        }
        return {
          status: hits.length ? "pass" : "info",
          summary: hits.length
            ? `handler fired ${hits.length}x (${[...new Set(hits.map((x) => x.action))].join(", ")})`
            : `not fired yet: open ${uri} from another app (Notes, chat, a QR code), then re-run M19`,
          data: { uri, pairUri: uri.replace("shuttle-enroll", "shuttle-pair"), hits },
        };
      },
    },
    {
      id: "M20",
      title: "DMP golden files byte-identical to Node",
      safe: true,
      async run(): Promise<ProbeOutcome> {
        // Goldens come from Node (packages/testkit/dmpGoldens.test.ts); compare the serialized form so
        // any difference in diffs, patch text, merged text or hunk results counts.
        const want = GOLDENS as unknown as DmpGolden[];
        const rows: { name: string; equal: boolean; ms: number; firstDiff?: string }[] = [];
        for (const c of DMP_CASES) {
          const g = want.find((x) => x.name === c.name);
          const t0 = performance.now();
          const got = computeGolden(c);
          const ms = Math.round(performance.now() - t0);
          const a = JSON.stringify(got);
          const b = JSON.stringify(g ?? null);
          const row: { name: string; equal: boolean; ms: number; firstDiff?: string } = { name: c.name, equal: a === b, ms };
          if (a !== b) {
            let i = 0;
            while (i < a.length && a[i] === b[i]) i++;
            row.firstDiff = `at ${i}: device ${JSON.stringify(a.slice(i, i + 40))} vs Node ${JSON.stringify(b.slice(i, i + 40))}`;
          }
          rows.push(row);
        }
        const bad = rows.filter((r) => !r.equal);
        return {
          status: bad.length === 0 && rows.length === want.length ? "pass" : "fail",
          summary: bad.length === 0 ? `${rows.length}/${want.length} golden cases byte-identical to Node` : `${bad.length} case(s) differ: ${bad.map((r) => r.name).join(", ")}`,
          data: { rows },
        };
      },
    },
    {
      id: "M21",
      title: "onunload on disable; memory-pressure kill",
      safe: true,
      async run(ctx): Promise<ProbeOutcome> {
        const ps = ctx.state.previousSession as { id?: string; start?: number } | null;
        const pu = ctx.state.previousUnload as { id?: string; ts?: number; error?: string } | null;
        let verdict: string;
        let status: ProbeOutcome["status"] = "info";
        if (!ps?.id) verdict = "no previous session recorded (first run): disable/enable the plugin or force-quit, then re-run";
        else if (pu?.id === ps.id) {
          verdict = pu.error ? `previous session unloaded WITH error: ${pu.error}` : "previous session ran onunload cleanly";
          status = pu.error ? "fail" : "pass";
        } else verdict = "previous session ended WITHOUT onunload (force-quit, crash or OS kill)";
        const m16 = ctx.app.loadLocalStorage("shuttle-spike-m16-inflight") as number | null;
        return {
          status,
          summary: `${verdict}${m16 ? "; an M16 readBinary was in flight when the app died" : ""}`,
          data: { previousSession: ps, previousUnload: pu, m16InflightSince: m16 },
        };
      },
    },
    {
      id: "M23",
      title: "Sidebar view tab icon and ribbon icon update live",
      safe: false,
      async run(ctx): Promise<ProbeOutcome> {
        const leaf = await h.openSpikeView();
        const icons = ["circle", "check-circle", "alert-triangle", "refresh-cw", "cloud"];
        const ribbon = h.ribbonEl();
        const leafAny = leaf as unknown as { updateHeader?: () => void; tabHeaderInnerIconEl?: HTMLElement };
        const updateHeader = typeof leafAny.updateHeader === "function";
        try {
          for (let i = 0; i < icons.length * 2; i++) {
            const icon = icons[i % icons.length]!;
            ctx.state.viewIcon = icon;
            if (updateHeader) leafAny.updateHeader!();
            else if (leafAny.tabHeaderInnerIconEl) setIcon(leafAny.tabHeaderInnerIconEl, icon);
            if (ribbon) {
              setIcon(ribbon, icon);
              ribbon.toggleClass("shuttle-spike-state-err", i % 2 === 1);
            }
            ctx.progress(`M23: icon ${icon}`);
            await sleep(1200);
          }
        } finally {
          ctx.state.viewIcon = "flask-conical";
          if (updateHeader) leafAny.updateHeader!();
          if (ribbon) {
            setIcon(ribbon, "flask-conical");
            ribbon.removeClass("shuttle-spike-state-err");
          }
        }
        const tab = await ctx.ask("Did the sidebar TAB icon change live (5 icons, twice)?", ["Yes", "No", "Tab not visible"]);
        const rib = await ctx.ask("Did the RIBBON icon change and turn red every other step?", ["Yes", "Icon only", "No", "No ribbon (mobile)"]);
        leaf.detach();
        return {
          status: tab === "Yes" && (rib === "Yes" || rib === "No ribbon (mobile)") ? "pass" : "fail",
          summary: `tab icon: ${tab ?? "?"}; ribbon: ${rib ?? "?"}; leaf.updateHeader ${updateHeader ? "present" : "missing"}`,
          data: { tab, ribbon: rib, updateHeader },
        };
      },
    },
    {
      id: "M24",
      title: "Private APIs app.setting.open/openTabById, executeCommandById('app:reload')",
      safe: true,
      async run(ctx): Promise<ProbeOutcome> {
        const app = ctx.app as AppPrivate;
        const data: Record<string, unknown> = {
          settingOpen: typeof app.setting?.open === "function",
          settingOpenTabById: typeof app.setting?.openTabById === "function",
          settingClose: typeof app.setting?.close === "function",
          executeCommandById: typeof app.commands?.executeCommandById === "function",
          appReloadCommand: !!app.commands?.commands?.["app:reload"],
        };
        if (!ctx.batch && data.settingOpen && data.settingOpenTabById) {
          try {
            app.setting!.open!();
            data.openTab = String(!!app.setting!.openTabById!("shuttle-spike"));
            await sleep(1000);
            app.setting!.close?.();
          } catch (e) {
            data.openTab = errMsg(e);
          }
        }
        const all = Object.entries(data).every(([k, v]) => k === "openTab" || v === true);
        return {
          status: all ? "pass" : "info",
          summary: `${Object.entries(data).map(([k, v]) => `${k}=${String(v)}`).join(", ")}${all ? "" : " (fallbacks needed)"}; run "M24 reload" to test plugin reload`,
          data,
        };
      },
    },
    {
      id: "M24-reload",
      title: "app:reload: does it reload plugins?",
      safe: false,
      confirm: "Runs the command app:reload. Obsidian reloads; the spike records whether it came back.",
      async run(ctx): Promise<ProbeOutcome> {
        const app = ctx.app as AppPrivate;
        if (typeof app.commands?.executeCommandById !== "function") return { status: "fail", summary: "executeCommandById missing" };
        await h.setReloadMarker({ ts: Date.now(), loadedAt: ctx.state.loadedAt });
        await sleep(300);
        const ran = app.commands.executeCommandById("app:reload");
        await sleep(5000);
        await h.setReloadMarker(null);
        return {
          status: "fail",
          summary: `executeCommandById returned ${String(ran)} but this plugin instance is still running after 5 s: no reload`,
          data: { ran },
        };
      },
    },
  ];
}
