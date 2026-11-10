// Temp-file patterns that are always `ignored` (design §3.11.5). Pure; no regex lookbehind.

const TEMP_SUFFIXES = [".swp", ".swx", ".crdownload", ".part", ".download"];
const TEMP_EXACT = new Set(["thumbs.db", "desktop.ini"]);
/** `*.tmp.<digits>.<hex>` (atomic-save temps). */
const ATOMIC_TMP = /\.tmp\.[0-9]+\.[0-9a-fA-F]+$/;
/** `sed` + exactly 6 alphanumerics (sed -i temps). */
const SED_TMP = /^sed[A-Za-z0-9]{6}$/;
/** LibreOffice lock files `.~lock.<name>#`. */
const LO_LOCK = /^\.~lock\..*#$/;

/** True when the file NAME (last segment) matches a temp pattern. */
export function isTempName(name: string): boolean {
  if (name.length === 0) return false;
  const lower = name.toLowerCase();
  if (TEMP_EXACT.has(lower)) return true;
  if (name.endsWith("~")) return true;
  if (name.startsWith(".#") || name.startsWith("~$")) return true;
  for (const s of TEMP_SUFFIXES) if (lower.endsWith(s)) return true;
  return ATOMIC_TMP.test(name) || SED_TMP.test(name) || LO_LOCK.test(name);
}

/** Engine-internal names (design §3.11 step 1): swap parking files, temp downloads, replace temps (D8). */
export function isEngineInternalName(name: string): boolean {
  return name.startsWith(".shuttle-swap-") || name.startsWith(".shuttle-tmp-") || name.startsWith(".shuttle-replace-");
}
