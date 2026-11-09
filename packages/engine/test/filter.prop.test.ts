// I12 filters never delete, I13 filtered never downloads, I14 ignored paths never tracked (design §3.18,
// §7.2): random filter changes on one device interleaved with remote edits and creates on another
// (including edits made while the path is excluded, S11), then everything re-enabled converges.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeviceSettings, FileEntry } from "@shuttle/protocol";
import { DEFAULT_CONFIG_CATEGORIES, DEFAULT_SELECTIVE } from "../src/index";
import { Node, makeWorld, serverMap, sortedEntries, syncAll } from "./engineHarness";

type Cmd =
  | { t: "exclude"; on: boolean }
  | { t: "images"; on: boolean }
  | { t: "pdfs"; on: boolean }
  | { t: "hotkeys"; on: boolean }
  | { t: "remoteEdit"; i: number; n: number }
  | { t: "remoteCreate"; i: number; n: number }
  | { t: "localEdit"; i: number; n: number };

const FILES = ["notes/a.md", "Private/p.md", "img/x.png", "doc/d.pdf", ".obsidian/hotkeys.json", ".obsidian/app.json"];
const CREATE = ["Private/new.md", "img/new.png", "doc/new.pdf", "notes/new.md"];
const IGNORED = [".git/HEAD", "notes/a.md.tmp.123.abcd", ".obsidian/plugins/shuttle/data.json", "notes/.secret.md", "Thumbs.db", "sedAb12Z9"];

const body = (p: string, n: number): string => (p.endsWith(".json") ? JSON.stringify({ k: n, p }, null, 2) : `${p} v${n}\n`);

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ t: fc.constant("exclude" as const), on: fc.boolean() }),
  fc.record({ t: fc.constant("images" as const), on: fc.boolean() }),
  fc.record({ t: fc.constant("pdfs" as const), on: fc.boolean() }),
  fc.record({ t: fc.constant("hotkeys" as const), on: fc.boolean() }),
  fc.record({ t: fc.constant("remoteEdit" as const), i: fc.nat(FILES.length - 1), n: fc.nat(99) }),
  fc.record({ t: fc.constant("remoteCreate" as const), i: fc.nat(CREATE.length - 1), n: fc.nat(99) }),
  fc.record({ t: fc.constant("localEdit" as const), i: fc.nat(FILES.length - 1), n: fc.nat(99) }),
);

describe("filters (I12-I14)", () => {
  it("random filter changes never delete, never download filtered paths, never track ignored paths", async () => {
    let seed = 0;
    await fc.assert(fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 8 }), async (cmds) => {
      const w = await makeWorld(`filter-prop-${seed++}`);
      const a = new Node(w, { name: "alpha" });
      const b = new Node(w, { name: "beta" });
      const seed0: Record<string, string> = {};
      for (const p of FILES) seed0[p] = body(p, 0);
      for (const p of IGNORED) seed0[p] = "ignored";
      a.fs.seed(seed0);
      await a.start();
      await b.start();
      await syncAll([a, b]);

      const settings: Pick<DeviceSettings, "excludedFolders" | "selective" | "configCategories"> = {
        excludedFolders: [], selective: { ...DEFAULT_SELECTIVE }, configCategories: { ...DEFAULT_CONFIG_CATEGORIES },
      };
      const violations: string[] = [];
      a.fs.before((op, path) => {
        if ((op === "write" || op === "remove") && a.engine) {
          const sc = a.engine.filter.scope(path);
          if (op === "remove") violations.push(`remove ${path}`);
          else if (sc !== "active" && sc !== "ignored") violations.push(`write ${path} while ${sc}`);
        }
      });
      const frozen = new Map<string, FileEntry["synced"]>();
      const checkTracked = (): void => {
        for (const e of a.engine.index.all()) {
          if (IGNORED.includes(e.path)) violations.push(`tracked ${e.path}`);
          if (e.scope !== "active") {
            const prev = frozen.get(e.fileId);
            if (prev === undefined) frozen.set(e.fileId, e.synced);
            else if (JSON.stringify(prev) !== JSON.stringify(e.synced)) violations.push(`synced changed while ${e.scope}: ${e.path}`);
          } else frozen.delete(e.fileId);
        }
      };
      checkTracked();
      for (const c of cmds) {
        w.clock.tick(1000);
        switch (c.t) {
          case "exclude": settings.excludedFolders = c.on ? ["Private"] : []; await a.engine.updateSettings({ excludedFolders: settings.excludedFolders }); break;
          case "images": settings.selective.images = !c.on; await a.engine.updateSettings({ selective: { ...settings.selective } }); break;
          case "pdfs": settings.selective.pdfs = !c.on; await a.engine.updateSettings({ selective: { ...settings.selective } }); break;
          case "hotkeys": settings.configCategories.hotkey = !c.on; await a.engine.updateSettings({ configCategories: { ...settings.configCategories } }); break;
          case "remoteEdit": { const p = FILES[c.i]!; if (b.fs.exists(p)) { b.fs.external.write(p, body(p, c.n + 1)); b.engine.requestScan(); } break; }
          case "remoteCreate": { const p = CREATE[c.i]!; b.fs.external.write(p, body(p, c.n + 1)); b.engine.requestScan(); break; }
          case "localEdit": { const p = FILES[c.i]!; a.fs.external.write(p, body(p, c.n + 200)); a.engine.requestScan(); break; }
        }
        await syncAll([a, b]);
        checkTracked();
      }
      // No device ever pushed a delete, and A never removed a file.
      expect(w.server.inspect().log.filter((r) => r.kind === "del")).toEqual([]);
      expect(violations).toEqual([]);
      // Re-enable everything: 3-way behavior resumes and everyone converges (I12, I7).
      await a.engine.updateSettings({ excludedFolders: [], selective: { ...DEFAULT_SELECTIVE }, configCategories: { ...DEFAULT_CONFIG_CATEGORIES } });
      await syncAll([a, b], 20);
      await syncAll([b, a], 20);
      const am = await a.diskMap();
      expect(sortedEntries(am)).toEqual(sortedEntries(await serverMap(w)));
      expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(am));
      expect(violations).toEqual([]);
      for (const p of IGNORED) expect(a.engine.index.byPath(p), p).toBeNull();
    }), { numRuns: 20, seed: 1213 });
  }, 120_000);
});
