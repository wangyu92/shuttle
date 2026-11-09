// LocalFs contract (design §3.2). The interface lives in @shuttle/protocol so platforms and fakes
// implement it without depending on the engine; re-exported here to keep the §3.1 layout.
export type { LocalEvent, LocalFs, LocalFsErrorCode, LocalPlatform, LocalStat, RemoveMode, Disposable } from "@shuttle/protocol";

/** True when `e` is a LocalFs error with `code` (implementations attach `code`, design §3.2). */
export function hasFsCode(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;
}
