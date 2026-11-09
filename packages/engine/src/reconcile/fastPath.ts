// Fast-path stat comparison (design §3.4.1, P5). Pure.

import type { FileObservation, LocalPlatform, LocalStat } from "@shuttle/protocol";

/**
 * True when the stored observation still describes the file: same mtime and size, and on Node also
 * the same inode and ctime (an external tool can keep mtime and size while changing content).
 */
export function fastPathMatch(obs: FileObservation, st: LocalStat, platform: LocalPlatform): boolean {
  if (obs.mtime !== st.mtime || obs.size !== st.size) return false;
  if (platform !== "node") return true;
  return obs.ino === st.ino && obs.ctimeMs === st.ctimeMs;
}

export function observationOf(st: LocalStat, hash: string | null): FileObservation {
  const o: FileObservation = { mtime: st.mtime, size: st.size, hash };
  if (st.ino !== undefined) o.ino = st.ino;
  if (st.ctimeMs !== undefined) o.ctimeMs = st.ctimeMs;
  return o;
}
