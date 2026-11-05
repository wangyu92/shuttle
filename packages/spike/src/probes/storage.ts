// Storage and vault-file probes: M10, M11, M12, M13, M13b, M14, M15, M16, M18, M22.
// Every file probe works under ctx.tmpDir and removes what it created in a finally block.
import { type App, MarkdownView, TFile, normalizePath } from "obsidian";
import type { Ctx, Probe, ProbeOutcome } from "../types.js";
import { MiB, errMsg, now, randomBytes, round, sleep, toHex } from "../util.js";

// ---------- IndexedDB helpers ----------

function idbReq<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IDB request failed"));
  });
}

function idbTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IDB tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IDB tx aborted"));
  });
}

async function openDb(name: string): Promise<IDBDatabase> {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("s");
  };
  return idbReq(r);
}

async function deleteDb(name: string): Promise<string> {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve("deleted");
    r.onerror = () => resolve(`delete failed: ${String(r.error)}`);
    r.onblocked = () => resolve("delete blocked");
  });
}

async function estimate(): Promise<Record<string, unknown>> {
  const s = navigator.storage;
  if (!s?.estimate) return { estimate: "n/a" };
  try {
    const e = await s.estimate();
    return { usage: e.usage ?? null, quota: e.quota ?? null };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

// ---------- vault helpers ----------

async function rmIfExists(ctx: Ctx, path: string): Promise<void> {
  try {
    if (await ctx.app.vault.adapter.exists(path)) await ctx.app.vault.adapter.remove(path);
  } catch {
    /* best effort */
  }
}

function tmpPath(ctx: Ctx, name: string): string {
  return normalizePath(`${ctx.tmpDir}/${name}`);
}

/** Writes `total` bytes in 4 MiB appendBinary steps (falls back to string append if missing). */
async function appendChunks(ctx: Ctx, path: string, total: number): Promise<{ ms: number; method: string; chunks: number }> {
  const a = ctx.app.vault.adapter as typeof ctx.app.vault.adapter & { appendBinary?: (p: string, d: ArrayBuffer) => Promise<void> };
  const chunk = 4 * MiB;
  await a.write(path, "");
  const t0 = now();
  let n = 0;
  for (let off = 0; off < total; off += chunk) {
    const size = Math.min(chunk, total - off);
    if (typeof a.appendBinary === "function") await a.appendBinary(path, randomBytes(size).buffer);
    else await a.append(path, "x".repeat(size));
    n++;
    ctx.progress(`appended ${Math.round((off + size) / MiB)} MiB`);
  }
  return { ms: round(now() - t0), method: typeof a.appendBinary === "function" ? "appendBinary" : "append(string)", chunks: n };
}

// ---------- config backups and crash cleanup (a kill skips finally blocks) ----------

const RESTORE_SUBDIR = "restore";

function backupPath(tmpDir: string, path: string): string {
  return normalizePath(`${tmpDir}/${RESTORE_SUBDIR}/${path.replace(/[^A-Za-z0-9._-]+/g, "_")}.backup.json`);
}

/** Saves the original bytes of a config file under tmp/restore before a probe changes it. */
async function backupConfig(ctx: Ctx, path: string): Promise<string | null> {
  const a = ctx.app.vault.adapter;
  const existed = await a.exists(path);
  const content = existed ? await a.read(path) : null;
  await ctx.ensureFolder(`${ctx.tmpDir}/${RESTORE_SUBDIR}`);
  await a.write(backupPath(ctx.tmpDir, path), JSON.stringify({ path, existed, content }));
  return content;
}

async function restoreConfig(ctx: Ctx, path: string, original: string | null): Promise<void> {
  if (original !== null) await ctx.app.vault.adapter.write(path, original);
  else await rmIfExists(ctx, path);
  await rmIfExists(ctx, backupPath(ctx.tmpDir, path));
}

async function listRecursive(app: App, dir: string): Promise<{ files: string[]; folders: string[] }> {
  const out = { files: [] as string[], folders: [] as string[] };
  const l = await app.vault.adapter.list(dir);
  out.files.push(...l.files);
  for (const f of l.folders) {
    const sub = await listRecursive(app, f);
    out.files.push(...sub.files);
    out.folders.push(...sub.folders, f);
  }
  return out;
}

/**
 * Runs at onload (after layout ready): restores config files a killed M13b left changed, removes
 * everything under tmpDir (M15/M16 50 MiB dotfiles, M18 corpus notes, M14/M22 test notes) and deletes
 * the M10/M11 IndexedDB databases. Returns a list of what it did (empty when there was nothing).
 */
export async function crashCleanup(app: App, tmpDir: string): Promise<string[]> {
  const a = app.vault.adapter;
  const done: string[] = [];
  if (await a.exists(tmpDir)) {
    const restoreDir = normalizePath(`${tmpDir}/${RESTORE_SUBDIR}`);
    if (await a.exists(restoreDir)) {
      for (const f of (await a.list(restoreDir)).files) {
        try {
          const b = JSON.parse(await a.read(f)) as { path?: string; existed?: boolean; content?: string | null };
          if (typeof b.path === "string" && b.path.startsWith(app.vault.configDir + "/")) {
            if (b.existed && typeof b.content === "string") await a.write(b.path, b.content);
            else if (await a.exists(b.path)) await a.remove(b.path);
            done.push(`restored ${b.path}`);
          }
        } catch (e) {
          done.push(`could not restore from ${f}: ${errMsg(e)}`);
        }
      }
    }
    const { files, folders } = await listRecursive(app, tmpDir);
    for (const f of files) {
      try {
        const tf = app.vault.getAbstractFileByPath(f);
        if (tf instanceof TFile) await app.vault.delete(tf, true);
        else await a.remove(f);
      } catch {
        /* reported by the count below */
      }
    }
    for (const d of folders) {
      try {
        await a.rmdir(d, false);
      } catch {
        /* not empty or already gone */
      }
    }
    if (files.length) done.push(`removed ${files.length} leftover file(s) under ${tmpDir}`);
  }
  for (const name of ["shuttle-spike-m10", "shuttle-spike-m11"]) {
    const dbs = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases;
    let present = true;
    if (typeof dbs === "function") {
      try {
        present = (await dbs.call(indexedDB)).some((d) => d.name === name);
      } catch {
        present = true;
      }
    }
    if (present) {
      const r = await deleteDb(name);
      if (typeof dbs === "function") done.push(`IndexedDB ${name}: ${r}`);
    }
  }
  return done;
}

export const storageProbes: Probe[] = [
  {
    id: "M10",
    title: "IndexedDB put 10k x 400 B; getAll 10k",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const name = "shuttle-spike-m10";
      await deleteDb(name);
      const db = await openDb(name);
      try {
        const val = randomBytes(400);
        const t0 = now();
        const tx = db.transaction("s", "readwrite");
        const st = tx.objectStore("s");
        for (let i = 0; i < 10000; i++) st.put(val.slice().buffer, i);
        await idbTx(tx);
        const putMs = round(now() - t0);
        const t1 = now();
        const all = await idbReq(db.transaction("s", "readonly").objectStore("s").getAll());
        const getAllMs = round(now() - t1);
        const ok = all.length === 10000;
        return {
          status: ok && putMs < 5000 && getAllMs < 500 ? "pass" : "fail",
          summary: `put ${putMs} ms (limit 5000), getAll ${getAllMs} ms (limit 500), count ${all.length}`,
          data: { putMs, getAllMs, count: all.length },
        };
      } finally {
        db.close();
        await deleteDb(name);
      }
    },
  },
  {
    id: "M11",
    title: "200 MiB in IndexedDB; estimate(); persist()",
    safe: false,
    confirm: "Writes 200 MiB into a temporary IndexedDB database, then deletes it. Needs free storage.",
    async run(ctx): Promise<ProbeOutcome> {
      const name = "shuttle-spike-m11";
      await deleteDb(name);
      const before = await estimate();
      let persisted: unknown = "n/a";
      let persistResult: unknown = "n/a";
      try {
        persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : "n/a";
        persistResult = navigator.storage?.persist ? await navigator.storage.persist() : "n/a";
      } catch (e) {
        persistResult = errMsg(e);
      }
      const db = await openDb(name);
      let written = 0;
      let error: string | null = null;
      const t0 = now();
      try {
        for (let batch = 0; batch < 25 && !error; batch++) {
          const tx = db.transaction("s", "readwrite");
          const st = tx.objectStore("s");
          for (let i = 0; i < 8; i++) st.put(randomBytes(MiB).buffer, batch * 8 + i);
          try {
            await idbTx(tx);
            written += 8;
          } catch (e) {
            error = errMsg(e);
          }
          ctx.progress(`M11: ${written} MiB`);
        }
        const during = await estimate();
        return {
          status: error ? "fail" : "info",
          summary: error ? `failed after ${written} MiB: ${error}` : `200 MiB ok in ${round(now() - t0)} ms; quota ${String(during.quota)}; persist() -> ${String(persistResult)}`,
          data: { writtenMiB: written, ms: round(now() - t0), error, before, during, persistedBefore: persisted, persistResult },
        };
      } finally {
        db.close();
        await deleteDb(name);
      }
    },
  },
  {
    id: "M12/P0-C10",
    title: "saveLocalStorage survives force-quit / idle days",
    safe: true,
    async run(ctx): Promise<ProbeOutcome> {
      const prev = ctx.state.previousM12 as { ts?: number; nonce?: string } | null;
      const nonce = toHex(randomBytes(4));
      ctx.app.saveLocalStorage("shuttle-spike-m12", { ts: Date.now(), nonce });
      const readBack = ctx.app.loadLocalStorage("shuttle-spike-m12") as { nonce?: string } | null;
      const ageH = prev?.ts ? round((Date.now() - prev.ts) / 3_600_000, 2) : null;
      return {
        status: prev?.ts ? "pass" : "info",
        summary: prev?.ts
          ? `marker from previous launch present, age ${ageH} h (wrote new marker)`
          : "no marker from a previous launch (first run, or it was lost); new marker written: force-quit and re-run",
        data: { previous: prev, ageHours: ageH, newNonce: nonce, readBackOk: readBack?.nonce === nonce },
      };
    },
  },
  {
    id: "M13",
    title: "vault.on('raw') for an adapter write in configDir",
    safe: true,
    async run(ctx): Promise<ProbeOutcome> {
      const path = normalizePath(`${ctx.app.vault.configDir}/shuttle-spike-raw-probe.json`);
      const start = Date.now();
      try {
        await ctx.app.vault.adapter.write(path, JSON.stringify({ t: start }));
        let hitMs: number | null = null;
        for (let i = 0; i < 40 && hitMs === null; i++) {
          const hit = ctx.state.rawEvents.find((e) => e.t >= start && e.path === path);
          if (hit) hitMs = hit.t - start;
          else await sleep(50);
        }
        const configEvents = ctx.state.rawEvents.filter((e) => e.path.startsWith(ctx.app.vault.configDir + "/")).length;
        return {
          status: hitMs !== null && hitMs < 2000 ? "pass" : "fail",
          summary: hitMs !== null ? `raw event after ${hitMs} ms` : "no raw event within 2 s: the periodic config scan stays mandatory",
          data: { hitMs, configDirEventsSinceLoad: configEvents },
        };
      } finally {
        await rmIfExists(ctx, path);
      }
    },
  },
  {
    id: "M13b",
    title: "app.json/hotkeys.json/appearance.json written by the adapter: applied without reload? rewritten on save?",
    safe: false,
    confirm: "Changes 'showLineNumber' in app.json, adds a spike hotkey to hotkeys.json and nudges the font size (appearance.json), each through the adapter or setConfig, then restores the original bytes. Backups go to the spike tmp folder and are restored at the next start if Obsidian dies. Then asks you to toggle any setting by hand.",
    async run(ctx): Promise<ProbeOutcome> {
      const a = ctx.app.vault.adapter;
      const cfg = ctx.app.vault.configDir;
      const appPath = normalizePath(`${cfg}/app.json`);
      const hkPath = normalizePath(`${cfg}/hotkeys.json`);
      const apPath = normalizePath(`${cfg}/appearance.json`);
      const vault = ctx.app.vault as unknown as { getConfig?: (k: string) => unknown; setConfig?: (k: string, v: unknown) => void };
      const getConfig = (k: string): unknown => vault.getConfig?.(k);
      const setConfig = typeof vault.setConfig === "function" ? (k: string, v: unknown) => vault.setConfig!(k, v) : null;
      const data: Record<string, unknown> = { setConfigAvailable: !!setConfig };

      // ---- app.json: adapter write, applied live? passive rewrite? ----
      const appOrig = await backupConfig(ctx, appPath);
      const before = getConfig("showLineNumber");
      data.before = before;
      try {
        const obj = (appOrig ? JSON.parse(appOrig) : {}) as Record<string, unknown>;
        const target = !(before === true);
        obj.showLineNumber = target;
        const written = JSON.stringify(obj, null, 2);
        const start = Date.now();
        await a.write(appPath, written);
        let appliedMs: number | null = null;
        for (let i = 0; i < 40 && appliedMs === null; i++) {
          await sleep(50);
          if (getConfig("showLineNumber") === target) appliedMs = Date.now() - start;
        }
        await sleep(3000);
        const after = await a.read(appPath);
        data.target = target;
        data.appliedWithoutReloadMs = appliedMs;
        data.rawEventSeen = ctx.state.rawEvents.some((e) => e.t >= start && e.path === appPath);
        data.rewrittenPassively = after !== written;
        if (after !== written) data.rewrittenPassivelySample = after.slice(0, 300);
      } finally {
        await restoreConfig(ctx, appPath, appOrig);
        await sleep(500);
        // The bytes are back; the live setting may still be flipped and would be saved again later.
        if (getConfig("showLineNumber") !== before && setConfig) {
          setConfig("showLineNumber", before);
          data.liveSettingRestoredViaSetConfig = true;
          await sleep(1000);
          await restoreConfig(ctx, appPath, appOrig);
        }
        data.restoredConfig = getConfig("showLineNumber");
      }

      // ---- app.json: does Obsidian's own save rewrite the bytes (key order, defaults)? ----
      if (setConfig && appOrig !== null) {
        await backupConfig(ctx, appPath);
        try {
          setConfig("showLineNumber", !(before === true));
          await sleep(500);
          setConfig("showLineNumber", before === undefined ? false : before);
          await sleep(1500);
          const saved = await a.read(appPath);
          data.appRewrittenOnSave = saved !== appOrig;
          if (saved !== appOrig) data.appSavedSample = saved.slice(0, 300);
        } finally {
          await restoreConfig(ctx, appPath, appOrig);
        }
      }

      // ---- appearance.json: round-trip through setConfig ----
      const fs = getConfig("baseFontSize");
      if (setConfig && typeof fs === "number" && (await a.exists(apPath))) {
        const apOrig = await backupConfig(ctx, apPath);
        try {
          setConfig("baseFontSize", fs + 1);
          await sleep(500);
          setConfig("baseFontSize", fs);
          await sleep(1500);
          const saved = await a.read(apPath);
          data.appearanceRewrittenOnSave = saved !== apOrig;
          if (saved !== apOrig) data.appearanceSavedSample = saved.slice(0, 300);
        } finally {
          await restoreConfig(ctx, apPath, apOrig);
        }
      } else data.appearance = "skipped (no setConfig, no numeric baseFontSize, or no appearance.json)";

      // ---- hotkeys.json: adapter write, applied without reload? ----
      const hm = (ctx.app as unknown as { hotkeyManager?: { customKeys?: Record<string, unknown>; getHotkeys?: (id: string) => unknown; removeHotkeys?: (id: string) => void } }).hotkeyManager;
      const cmd = "shuttle-spike:copy-results";
      const live = () => (hm?.customKeys ? hm.customKeys[cmd] : hm?.getHotkeys?.(cmd));
      if (hm && (hm.customKeys || hm.getHotkeys)) {
        const hkOrig = await backupConfig(ctx, hkPath);
        try {
          const obj = (hkOrig ? JSON.parse(hkOrig) : {}) as Record<string, unknown>;
          obj[cmd] = [{ modifiers: ["Mod", "Shift"], key: "F12" }];
          const start = Date.now();
          await a.write(hkPath, JSON.stringify(obj, null, 2));
          let hkMs: number | null = null;
          for (let i = 0; i < 40 && hkMs === null; i++) {
            await sleep(50);
            const v = live();
            if (Array.isArray(v) && v.length > 0) hkMs = Date.now() - start;
          }
          data.hotkeysAppliedWithoutReloadMs = hkMs;
        } finally {
          await restoreConfig(ctx, hkPath, hkOrig);
          await sleep(1000);
          const still = live();
          data.hotkeyStillLiveAfterRestore = Array.isArray(still) && still.length > 0;
          if (data.hotkeyStillLiveAfterRestore && hm.removeHotkeys) {
            hm.removeHotkeys(cmd);
            data.hotkeyRemovedViaRemoveHotkeys = true;
            await sleep(500);
            await restoreConfig(ctx, hkPath, hkOrig);
          }
        }
      } else data.hotkeys = "skipped (app.hotkeyManager not available)";

      // Manual part: does a settings toggle in the UI produce a raw event?
      const go = await ctx.ask("Open Settings and toggle any option within 15 s after pressing Start (toggle it back afterwards).", ["Start", "Skip"]);
      if (go === "Start") {
        const t = Date.now();
        await sleep(15000);
        const evs = ctx.state.rawEvents.filter((e) => e.t >= t && e.path.startsWith(cfg + "/"));
        data.uiToggleRawEvents = evs.map((e) => ({ path: e.path, afterMs: e.t - t }));
      }
      const applied = data.appliedWithoutReloadMs !== null;
      return {
        status: "info",
        summary: `app.json ${applied ? `applied in ${String(data.appliedWithoutReloadMs)} ms` : "NOT applied without reload"}; hotkeys.json ${data.hotkeysAppliedWithoutReloadMs === undefined ? "skipped" : data.hotkeysAppliedWithoutReloadMs === null ? "NOT applied without reload" : `applied in ${String(data.hotkeysAppliedWithoutReloadMs)} ms`}; rewritten on save: app.json ${String(data.appRewrittenOnSave ?? "n/a")}, appearance.json ${String(data.appearanceRewrittenOnSave ?? "n/a")}; restored`,
        data,
      };
    },
  },
  {
    id: "M14",
    title: "vault.process on an open note while typing (BOM/CRLF equality)",
    safe: false,
    confirm: "Creates a test note with BOM and CRLF and opens it. First it checks vault.process on the untouched note (do not type yet), then asks you to press Start and type continuously in the MIDDLE line while vault.process runs 20 times (once per second).",
    async run(ctx): Promise<ProbeOutcome> {
      const path = tmpPath(ctx, "m14-typing.md");
      await ctx.ensureFolder(ctx.tmpDir);
      await rmIfExists(ctx, path);
      const initial = "﻿line one\r\nTYPE HERE: \r\nline three\r\n";
      await ctx.app.vault.adapter.writeBinary(path, new TextEncoder().encode(initial).buffer);
      await sleep(500);
      let file = ctx.app.vault.getAbstractFileByPath(path);
      for (let i = 0; i < 20 && !(file instanceof TFile); i++) {
        await sleep(100);
        file = ctx.app.vault.getAbstractFileByPath(path);
      }
      if (!(file instanceof TFile)) return { status: "error", summary: "test note not indexed" };
      const f = file;
      const leaf = ctx.app.workspace.getLeaf(true);
      try {
        await leaf.openFile(f);
        await sleep(3000);
        // S20 equality, measured on the untouched file so autosave races cannot mix in.
        const diskBytes = new Uint8Array(await ctx.app.vault.adapter.readBinary(path));
        const disk0 = new TextDecoder("utf-8", { ignoreBOM: true }).decode(diskBytes);
        const baseline: Record<string, unknown> = { diskHasBom: diskBytes[0] === 0xef && diskBytes[1] === 0xbb && diskBytes[2] === 0xbf, diskHasCrlf: disk0.includes("\r\n") };
        await ctx.app.vault.process(f, (d) => {
          baseline.eqDisk = d === disk0;
          baseline.bom = d.startsWith("\uFEFF");
          baseline.crlf = d.includes("\r\n");
          baseline.len = d.length;
          baseline.diskLen = disk0.length;
          return d; // unchanged
        });
        await sleep(500);
        const afterBytes = new Uint8Array(await ctx.app.vault.adapter.readBinary(path));
        baseline.bytesUnchangedAfterNoopProcess = afterBytes.length === diskBytes.length && afterBytes.every((b, i) => b === diskBytes[i]);
        const go = await ctx.ask("Baseline recorded. Press Start, then type continuously in the MIDDLE line until the probe finishes (about 20 s).", ["Start", "Cancel"]);
        if (go !== "Start") return { status: "info", summary: `baseline only: process string == disk ${String(baseline.eqDisk)}, BOM ${String(baseline.bom)}, CRLF ${String(baseline.crlf)}`, data: { baseline } };
        const rows: { i: number; eqDisk: boolean; bom: boolean; crlf: boolean; cursorJump: boolean }[] = [];
        for (let i = 0; i < 20; i++) {
          ctx.progress(`M14: ${i + 1}/20, keep typing`);
          const view = leaf.view instanceof MarkdownView ? leaf.view : null;
          const cur0 = view?.editor.getCursor();
          const disk = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await ctx.app.vault.adapter.readBinary(path));
          let eqDisk = false;
          let bom = false;
          let crlf = false;
          await ctx.app.vault.process(f, (d) => {
            eqDisk = d === disk;
            bom = d.startsWith("﻿");
            crlf = d.includes("\r\n");
            return `${d}${d.endsWith("\n") ? "" : "\n"}<!-- spike ${i} -->\n`;
          });
          await sleep(100);
          const cur1 = view?.editor.getCursor();
          const cursorJump = !!cur0 && !!cur1 && (cur0.line !== cur1.line || Math.abs(cur0.ch - cur1.ch) > 3);
          rows.push({ i, eqDisk, bom, crlf, cursorJump });
          await sleep(900);
        }
        const lost = await ctx.ask("Did any keystroke get lost, or did the cursor jump?", ["No problem", "Lost keystrokes", "Cursor jumped", "Both"]);
        const eqCount = rows.filter((r) => r.eqDisk).length;
        const jumps = rows.filter((r) => r.cursorJump).length;
        const ok = lost === "No problem" && jumps === 0;
        return {
          status: ok ? "pass" : "fail",
          summary: `baseline (untouched) process string == disk ${String(baseline.eqDisk)}, no-op process kept bytes ${String(baseline.bytesUnchangedAfterNoopProcess)}; while typing: lost/cursor per user, == disk ${eqCount}/20 (autosave races), BOM seen ${rows.some((r) => r.bom)}, CRLF seen ${rows.some((r) => r.crlf)}, cursor jumps ${jumps}, user: ${lost ?? "no answer"}`,
          data: { baseline, rows, user: lost },
        };
      } finally {
        leaf.detach();
        await sleep(300);
        const tf = ctx.app.vault.getAbstractFileByPath(path);
        if (tf) await ctx.app.vault.delete(tf, true).catch(() => rmIfExists(ctx, path));
        else await rmIfExists(ctx, path);
      }
    },
  },
  {
    id: "M15",
    title: "adapter append 50 MiB in 4 MiB chunks, then rename",
    safe: false,
    confirm: "Writes a 50 MiB temporary file in 4 MiB chunks, renames it, then deletes it.",
    async run(ctx): Promise<ProbeOutcome> {
      await ctx.ensureFolder(ctx.tmpDir);
      const p1 = tmpPath(ctx, ".shuttle-spike-m15.bin");
      const p2 = tmpPath(ctx, ".shuttle-spike-m15-renamed.bin");
      try {
        const app = await appendChunks(ctx, p1, 50 * MiB);
        const t0 = now();
        await ctx.app.vault.adapter.rename(p1, p2);
        const renameMs = round(now() - t0);
        const st = await ctx.app.vault.adapter.stat(p2);
        const ok = st?.size === 50 * MiB;
        return { status: ok ? "pass" : "fail", summary: `${app.method} ${app.chunks} chunks in ${app.ms} ms, rename ${renameMs} ms, size ${String(st?.size)}`, data: { ...app, renameMs, size: st?.size ?? null } };
      } finally {
        await rmIfExists(ctx, p1);
        await rmIfExists(ctx, p2);
      }
    },
  },
  {
    id: "M16",
    title: "readBinary of 50 MiB",
    safe: false,
    confirm: "Writes a 50 MiB temporary file, reads it with readBinary, then deletes it. May crash a low-memory phone: that is what it measures.",
    async run(ctx): Promise<ProbeOutcome> {
      await ctx.ensureFolder(ctx.tmpDir);
      const p = tmpPath(ctx, ".shuttle-spike-m16.bin");
      try {
        await appendChunks(ctx, p, 50 * MiB);
        ctx.app.saveLocalStorage("shuttle-spike-m16-inflight", Date.now());
        const t0 = now();
        const buf = await ctx.app.vault.adapter.readBinary(p);
        const ms = round(now() - t0);
        const ok = buf.byteLength === 50 * MiB;
        return { status: ok ? "pass" : "fail", summary: `readBinary ${buf.byteLength} B in ${ms} ms`, data: { ms, bytes: buf.byteLength } };
      } finally {
        // Cleared here so a readBinary that throws (without killing the app) does not look like a crash
        // to M21. An OS kill skips this block, which is what M21 detects.
        ctx.app.saveLocalStorage("shuttle-spike-m16-inflight", null);
        await rmIfExists(ctx, p);
      }
    },
  },
  {
    id: "M18",
    title: "getFiles() + stat on this vault",
    safe: true,
    async run(ctx): Promise<ProbeOutcome> {
      const t0 = now();
      const files = ctx.app.vault.getFiles();
      let bytes = 0;
      for (const f of files) bytes += f.stat.size;
      const cachedMs = round(now() - t0);
      const t1 = now();
      const sample = files.slice(0, 4000);
      for (let i = 0; i < sample.length; i += 64) {
        await Promise.all(sample.slice(i, i + 64).map((f) => ctx.app.vault.adapter.stat(f.path)));
      }
      const adapterStatMs = round(now() - t1);
      const corpus = files.length >= 3500;
      return {
        status: corpus ? (cachedMs < 200 ? "pass" : "fail") : "info",
        summary: `${files.length} files: getFiles+cached stat ${cachedMs} ms, adapter.stat x${sample.length} ${adapterStatMs} ms${corpus ? "" : " (needs the 4k corpus: run 'M18 corpus')"}`,
        data: { files: files.length, bytes, cachedMs, adapterStatMs, adapterStatCount: sample.length },
      };
    },
  },
  {
    id: "M18-corpus",
    title: "getFiles() + stat on a generated 4k corpus",
    safe: false,
    confirm: "Creates 4,000 small notes in the spike's tmp folder, measures, then deletes them one by one (takes minutes).",
    async run(ctx): Promise<ProbeOutcome> {
      const dir = tmpPath(ctx, "corpus");
      await ctx.ensureFolder(dir);
      const created: string[] = [];
      try {
        for (let i = 0; i < 4000; i++) {
          const p = `${dir}/n${String(i).padStart(4, "0")}.md`;
          await ctx.app.vault.create(p, `# note ${i}\n${"lorem ipsum ".repeat(40)}\n`);
          created.push(p);
          if (i % 250 === 0) ctx.progress(`M18 corpus: created ${i}`);
        }
        await sleep(1000);
        const t0 = now();
        const files = ctx.app.vault.getFiles();
        let s = 0;
        for (const f of files) s += f.stat.size;
        const ms = round(now() - t0);
        return { status: ms < 200 ? "pass" : "fail", summary: `${files.length} files: getFiles+stat ${ms} ms`, data: { files: files.length, ms, bytes: s } };
      } finally {
        let n = 0;
        for (const p of created) {
          const f = ctx.app.vault.getAbstractFileByPath(p);
          try {
            if (f) await ctx.app.vault.delete(f, true);
            else await rmIfExists(ctx, p);
          } catch {
            await rmIfExists(ctx, p);
          }
          if (++n % 250 === 0) ctx.progress(`M18 corpus: removed ${n}`);
        }
        try {
          const folder = ctx.app.vault.getAbstractFileByPath(dir);
          if (folder) await ctx.app.vault.delete(folder, true);
        } catch {
          /* leave the empty folder */
        }
      }
    },
  },
  {
    id: "M22",
    title: "writeBinary to .shuttle-tmp-*, then adapter.rename over an existing file",
    safe: false,
    confirm: "Creates its own target note and a .shuttle-tmp file in the spike tmp folder, renames over the target, then deletes both.",
    async run(ctx): Promise<ProbeOutcome> {
      await ctx.ensureFolder(ctx.tmpDir);
      const a = ctx.app.vault.adapter;
      const target = tmpPath(ctx, "m22-target.md");
      const tmp = tmpPath(ctx, `.shuttle-tmp-${toHex(randomBytes(4))}`);
      const data: Record<string, unknown> = {};
      try {
        await a.write(target, "OLD");
        await a.writeBinary(tmp, new TextEncoder().encode("NEW").buffer);
        try {
          await a.rename(tmp, target);
          data.renameOver = "ok";
          data.targetContent = await a.read(target);
          data.tmpGone = !(await a.exists(tmp));
        } catch (e) {
          data.renameOver = errMsg(e);
          data.targetContent = await a.read(target).catch(() => null);
          // Fallback the engine would need: remove then rename (not atomic).
          try {
            await a.remove(target);
            await a.rename(tmp, target);
            data.removeThenRename = (await a.read(target)) === "NEW" ? "ok" : "content mismatch";
          } catch (e2) {
            data.removeThenRename = errMsg(e2);
          }
        }
        const atomic = data.renameOver === "ok" && data.targetContent === "NEW" && data.tmpGone === true;
        return {
          status: atomic ? "pass" : "info",
          summary: atomic ? "rename over an existing file replaced it" : `rename over existing: ${String(data.renameOver)}; fallback remove+rename: ${String(data.removeThenRename)} (use write intents, S9)`,
          data,
        };
      } finally {
        await rmIfExists(ctx, tmp);
        await rmIfExists(ctx, target);
      }
    },
  },
];
