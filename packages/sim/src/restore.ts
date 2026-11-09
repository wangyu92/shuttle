// DB-restore fault for I29 (design §2.6.1, §4.9.2, §7.4 "DB-restore fault"). FakeRemoteServer has no
// restore hook, so the sim builds a new server from a backup of the old one through its public
// (test-internal) surface: vault-info, every retained record and every blob. The seq high-water mark
// keeps head_seq at the pre-restore value (no seq is reused, ID-10); clients learn about the restore
// from snapshotRequired{reason:'rollback'}, which SimNet sends until the device accepts (the
// rollbackAck handshake of §2.6.1 is modelled in SimNet, not in the fake: see openIssues).

import type { BlobId, VaultInfo, VersionRecord } from "@shuttle/protocol";
import { FakeRemoteServer, type Prng } from "@shuttle/testkit";
import type { SimDevice } from "./device";
import type { SimWorld } from "./world";

export interface ServerBackup {
  info: VaultInfo;
  log: VersionRecord[];
  blobs: Array<[BlobId, Uint8Array]>;
  headSeq: number;
  minSeq: number;
}

/** A consistent copy of the server state (what `VACUUM INTO` gives the operator). */
export function backupServer(srv: FakeRemoteServer): ServerBackup {
  const v = srv.inspect();
  if (!v.info) throw new Error("backupServer: no vault-info");
  const blobs: Array<[BlobId, Uint8Array]> = [];
  for (const id of v.blobIds) {
    const b = srv.getBlob(id);
    if (b) blobs.push([id, b]);
  }
  return { info: v.info, log: v.log, blobs, headSeq: v.headSeq, minSeq: v.minSeq };
}

/**
 * Replace the world's server with one restored from `b`. head_seq = max(backup, high-water mark of
 * the old server) (design §2.6.1). Every device is rebound and told about the rollback.
 */
export function restoreServer(w: SimWorld, b: ServerBackup, devices: readonly SimDevice[], prng: Prng): FakeRemoteServer {
  const old = w.server;
  const hwm = old.headSeq;
  old.disconnect();
  const srv = new FakeRemoteServer({ clock: w.clock, prng: prng.fork("restored-server") });
  srv.createInfo(structuredClone(b.info));
  for (const [id, bytes] of b.blobs) srv.putBlob(id, bytes);
  for (const rec of [...b.log].sort((x, y) => x.seq - y.seq)) srv.commitApply(structuredClone(rec));
  srv.headSeq = Math.max(b.headSeq, hwm);
  srv.setMinSeq(b.minSeq);
  w.server = srv;
  const rollbackAt = w.clock.now();
  for (const d of devices) d.net.rebind(srv, rollbackAt);
  return srv;
}
