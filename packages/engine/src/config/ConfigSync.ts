// Config sync reload handling (design §3.12). ConfigSync.noteApplied(path) collects the config files
// applied during one loop iteration; flush() returns one `configApplied` payload (or null).

import type { ConfigAppliedEvent, ConfigCategory } from "@shuttle/protocol";
import type { PathFilter } from "../filter/PathFilter";
import { configCategoryOf, reloadClassOf } from "../filter/configCategories";

export class ConfigSync {
  private paths = new Set<string>();

  constructor(private readonly filter: () => PathFilter) {}

  noteApplied(path: string): void {
    if (this.filter().configRel(path) !== null) this.paths.add(path);
  }

  get pending(): number {
    return this.paths.size;
  }

  flush(): ConfigAppliedEvent | null {
    if (this.paths.size === 0) return null;
    const f = this.filter();
    const categories = new Set<ConfigCategory>();
    const paths = [...this.paths].sort();
    const hot: string[] = [];
    let needsReload = false;
    this.paths.clear();
    for (const p of paths) {
      const rel = f.configRel(p);
      if (rel === null) continue;
      const cat = configCategoryOf(rel, f.s.pluginId);
      if (cat !== "never") categories.add(cat);
      const rc = reloadClassOf(rel, f.s.pluginId);
      if (rc.needsReload) needsReload = true;
      else hot.push(p);
    }
    return { categories, paths, needsReload, hot };
  }
}
