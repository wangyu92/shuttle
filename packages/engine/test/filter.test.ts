// PathFilter (design §3.11) and config categories (§3.12): the ten steps in order, per-platform caps,
// fingerprints, temp patterns.

import { describe, expect, it } from "vitest";
import {
  ConfigSync, DEFAULT_CONFIG_CATEGORIES, DEFAULT_SELECTIVE, MOBILE_CONFIG_MAX_BYTES, PathFilter, configCategoryOf, fileClassOf,
  isTempName, normalizeExcludedFolders, reloadClassOf, type FilterSettings,
} from "../src/index";

const MiB = 1024 * 1024;
const base: FilterSettings = {
  configDir: ".obsidian", pluginId: "shuttle", platform: "desktop", nameRules: "posix", caseInsensitive: false,
  excludedFolders: [], selective: { ...DEFAULT_SELECTIVE }, configCategories: { ...DEFAULT_CONFIG_CATEGORIES }, maxFileBytes: 200 * MiB,
};
const f = (o: Partial<FilterSettings> = {}) => new PathFilter({ ...base, ...o });

describe("PathFilter.scope order (design §3.11)", () => {
  it("engine-internal, dot segments and .nomedia are ignored", () => {
    const p = f();
    for (const path of [".shuttle-swap-ab-x.md", "d/.shuttle-tmp-1", ".git/config", ".trash/a.md", "a/.DS_Store", ".claude/x",
      ".obsidian-mobile/app.json", "x/.nomedia", "notes/.hidden.md", ".obsidian/.hidden.json"]) {
      expect(p.scope(path), path).toBe("ignored");
    }
    expect(p.scope("notes/a.md")).toBe("active");
  });

  it("own plugin data is ignored; other plugins are v2 (excluded)", () => {
    const p = f({ configCategories: { ...DEFAULT_CONFIG_CATEGORIES, "community-plugin-data": true, "community-plugin": true } });
    expect(p.scope(".obsidian/plugins/shuttle/data.json")).toBe("ignored");
    expect(p.scope(".obsidian/plugins/shuttle")).toBe("ignored");
    // v1 devices treat community-plugin* as excluded whatever the toggle says.
    expect(p.scope(".obsidian/plugins/other/main.js")).toBe("excluded");
    expect(p.scope(".obsidian/community-plugins.json")).toBe("excluded");
  });

  it("temp patterns are ignored (design §3.11.5)", () => {
    for (const n of ["a.md.tmp.123.ab12f", "sedAb12Z9", "x.swp", "x.swx", "x~", ".#lock", "~$doc.docx", "f.crdownload", "f.part",
      "f.download", ".~lock.report.odt#", "Thumbs.db", "desktop.ini"]) {
      expect(isTempName(n), n).toBe(true);
    }
    for (const n of ["sed12345", "sedAbc12Z9", "a.md", "tmp.md", "x.tmp", "part.md"]) expect(isTempName(n), n).toBe(false);
    expect(f().scope("notes/Thumbs.db")).toBe("ignored");
  });

  it("config categories map and toggle (design §3.12)", () => {
    expect(configCategoryOf("app.json")).toBe("app");
    expect(configCategoryOf("types.json")).toBe("app");
    expect(configCategoryOf("appearance.json")).toBe("appearance");
    expect(configCategoryOf("themes/Minimal/theme.css")).toBe("appearance-data");
    expect(configCategoryOf("snippets/x.css")).toBe("appearance-data");
    expect(configCategoryOf("hotkeys.json")).toBe("hotkey");
    expect(configCategoryOf("core-plugins.json")).toBe("core-plugin");
    expect(configCategoryOf("graph.json")).toBe("core-plugin-data");
    expect(configCategoryOf("someunknown.json")).toBe("core-plugin-data");
    for (const n of ["workspace.json", "workspace-mobile.json", "workspaces.json", "cache", "cache/x", "plugins/shuttle/data.json", "random.txt", "x/y.json"]) {
      expect(configCategoryOf(n), n).toBe("never");
    }
    const p = f();
    expect(p.scope(".obsidian/app.json")).toBe("active");
    expect(p.scope(".obsidian/workspace.json")).toBe("excluded");
    const off = f({ configCategories: { ...DEFAULT_CONFIG_CATEGORIES, hotkey: false } });
    expect(off.scope(".obsidian/hotkeys.json")).toBe("excluded");
    expect(off.scope(".obsidian/app.json")).toBe("active");
  });

  it("excluded folders: prefix + '/' match, configDir cannot be excluded", () => {
    const p = f({ excludedFolders: ["Private", "/a/b/", ".obsidian", ".obsidian/themes", ""] });
    expect(p.s.excludedFolders).toEqual(["Private", "a/b"]);
    expect(p.scope("Private/x.md")).toBe("excluded");
    expect(p.scope("Private2/x.md")).toBe("active");
    expect(p.scope("Private.md")).toBe("active");
    expect(p.scope("a/b/c/d.png")).toBe("excluded");
    expect(p.scope(".obsidian/themes/t.css")).toBe("active");
    expect(normalizeExcludedFolders(["x/", "x"], ".obsidian")).toEqual(["x"]);
    expect(f({ excludedFolders: ["Private"], caseInsensitive: true }).scope("private/x.md")).toBe("excluded");
    expect(f({ excludedFolders: ["Private"] }).scope("private/x.md")).toBe("active");
  });

  it("selective classes; notes, canvas and base always on", () => {
    const allOff = { images: false, audio: false, videos: false, pdfs: false, other: false };
    const p = f({ selective: allOff });
    expect(p.scope("a.md")).toBe("active");
    expect(p.scope("a.canvas")).toBe("active");
    expect(p.scope("a.base")).toBe("active");
    for (const x of ["a.PNG", "a.mp3", "a.mkv", "a.pdf", "a.zip", "noext"]) expect(p.scope(x), x).toBe("excluded");
    expect(fileClassOf("x.HEIC")).toBe("images");
    expect(fileClassOf("x.opus")).toBe("audio");
    expect(fileClassOf("x.m4v")).toBe("videos");
    expect(f({ selective: { ...DEFAULT_SELECTIVE, pdfs: false } }).scope("x.pdf")).toBe("excluded");
  });

  it("illegal names per platform, then the size caps", () => {
    expect(f({ nameRules: "windows" }).scope("a:b.md")).toBe("illegal");
    expect(f({ nameRules: "apple" }).scope("a:b.md")).toBe("illegal");
    expect(f().scope("a:b.md")).toBe("active");
    expect(f({ nameRules: "windows" }).scope("CON.md")).toBe("illegal");
    expect(f().scope("big.bin", 200 * MiB + 1)).toBe("oversize");
    expect(f().scope("big.bin", 200 * MiB)).toBe("active");
    const mob = f({ platform: "android", nameRules: "android", maxFileBytes: 50 * MiB });
    expect(mob.scope("v.mp4", 51 * MiB)).toBe("oversize");
    expect(mob.scope(".obsidian/app.json", MOBILE_CONFIG_MAX_BYTES + 1)).toBe("oversize");
    expect(f().scope(".obsidian/app.json", MOBILE_CONFIG_MAX_BYTES + 1)).toBe("active");
    // excluded wins over illegal (step 6 before step 8)
    expect(f({ nameRules: "windows", excludedFolders: ["x"] }).scope("x/a:b.md")).toBe("excluded");
  });

  it("a different configDir makes the old profile folder ignored (profiles)", () => {
    const p = f({ configDir: ".obsidian-mobile" });
    expect(p.scope(".obsidian/app.json")).toBe("ignored");
    expect(p.scope(".obsidian-mobile/app.json")).toBe("active");
  });

  it("fingerprint changes with every filter input and is stable otherwise", () => {
    const a = f().fingerprint();
    expect(f().fingerprint()).toBe(a);
    expect(f({ excludedFolders: ["x/"] }).fingerprint()).toBe(f({ excludedFolders: ["x"] }).fingerprint());
    const variants: Array<Partial<FilterSettings>> = [
      { excludedFolders: ["x"] }, { selective: { ...DEFAULT_SELECTIVE, images: false } },
      { configCategories: { ...DEFAULT_CONFIG_CATEGORIES, app: false } }, { maxFileBytes: 1 }, { configDir: ".other" },
      { nameRules: "windows" }, { pluginId: "x" },
    ];
    for (const v of variants) expect(f(v).fingerprint(), JSON.stringify(v)).not.toBe(a);
  });
});

describe("ConfigSync reload classification (design §3.12)", () => {
  it("collects applied config paths and emits once", () => {
    const p = f();
    const cs = new ConfigSync(() => p);
    cs.noteApplied(".obsidian/hotkeys.json");
    cs.noteApplied(".obsidian/app.json");
    cs.noteApplied("notes/a.md");
    const ev = cs.flush();
    expect(ev).not.toBeNull();
    expect(ev!.needsReload).toBe(false);
    expect(ev!.hot).toEqual([".obsidian/app.json", ".obsidian/hotkeys.json"]);
    expect([...ev!.categories].sort()).toEqual(["app", "hotkey"]);
    expect(cs.flush()).toBeNull();
    cs.noteApplied(".obsidian/themes/t/theme.css");
    cs.noteApplied(".obsidian/types.json");
    const ev2 = cs.flush()!;
    expect(ev2.needsReload).toBe(true);
    expect(ev2.hot).toEqual([".obsidian/types.json"]);
    expect(reloadClassOf("graph.json").needsReload).toBe(true);
    expect(reloadClassOf("core-plugins.json").needsReload).toBe(true);
    expect(reloadClassOf("plugins/x/main.js")).toEqual({ needsReload: true, forceQuitOnMobile: true });
    expect(reloadClassOf("daily-notes.json").needsReload).toBe(false);
  });
});
