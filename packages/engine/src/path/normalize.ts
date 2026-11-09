// Vault path normalization (design §2.3, §3.1 vocabulary). Pure.
//
// A vault path is POSIX-style: `/` separators, no leading or trailing `/`, NFC, case preserved.
// normalize() only does what is lossless: Unicode NFC and stripping leading/trailing slashes.
// Anything that would need a guess (`.`/`..` or empty segments, control characters) is NOT rewritten;
// path/illegal.ts reports it so the scope gate can mark the file `illegal` (design §3.11.4).
//
// foldKey = NFC(path).toLowerCase() (design §3.1). toLowerCase, never toLocaleLowerCase: the fold must
// be identical on every device whatever the UI locale. Engines may disagree on brand-new code points;
// that only causes a spurious PATH_TAKEN or a consistency warning, never data loss (design §2.3).

/** NFC, without leading or trailing `/`. Idempotent. */
export function normalizePath(p: string): string {
  let s = p.normalize("NFC");
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 47) a++;
  while (b > a && s.charCodeAt(b - 1) === 47) b--;
  if (a !== 0 || b !== s.length) s = s.slice(a, b);
  return s;
}

/** Case-folded key for local maps (design §3.1); equal for paths that differ only in case or normalization form. */
export function foldKey(p: string): string {
  return normalizePath(p).toLowerCase();
}

export function segments(p: string): string[] {
  return p === "" ? [] : p.split("/");
}

/** Parent folder ("" for a top-level entry). */
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Extension without the dot, lowercase-preserving ("" if none). The last dot counts; a leading dot
 * (".env") or a trailing dot ("name.") is not an extension separator.
 */
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 || i === b.length - 1 ? "" : b.slice(i + 1);
}

/** Basename without its extension (see extname for what counts as one). */
export function stem(p: string): string {
  const b = basename(p);
  const e = extname(b);
  return e === "" ? b : b.slice(0, b.length - e.length - 1);
}

export function join(...parts: readonly string[]): string {
  return parts.filter((x) => x !== "").join("/");
}

/** True when `p` is strictly inside folder `folder` ("" = vault root contains everything). Case-sensitive. */
export function isUnder(p: string, folder: string): boolean {
  if (folder === "") return p !== "";
  return p.length > folder.length && p.startsWith(folder) && p.charCodeAt(folder.length) === 47;
}

/** Same as isUnder, compared by foldKey. */
export function isUnderFolded(p: string, folder: string): boolean {
  return isUnder(foldKey(p), foldKey(folder));
}

/** Rewrite the `from/` prefix of `p` to `to/` (folder rename expansion, design §3.5). `p` must be under `from`. */
export function rebase(p: string, from: string, to: string): string {
  if (!isUnder(p, from)) throw new RangeError(`rebase: ${JSON.stringify(p)} is not under ${JSON.stringify(from)}`);
  return join(to, p.slice(from.length + 1));
}
