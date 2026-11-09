// SimWorld: the shared server, the base clock and the keyring of one simulated vault (design §7.4).
// The server clock is the unskewed base clock; each device sees its own skewed view of it.

import type { Keyring } from "@shuttle/protocol";
import { FakeClock, FakeKeyring, FakeRemoteServer, Prng, TestIds } from "@shuttle/testkit";
import type { ContentParams } from "@shuttle/engine";

export const CFG = ".obsidian";

/** Small FastCDC parameters so a few-KiB file already spans several chunks. */
export const SIM_PARAMS: ContentParams = {
  chunker: { min: 2048, avg: 4096, max: 16384 }, inlineMax: 4096, compression: "deflate-raw", padding: "none",
};

export interface SimWorld {
  readonly seed: number;
  readonly clock: FakeClock;
  server: FakeRemoteServer;
  readonly ring: Keyring;
  readonly ids: TestIds;
}

export async function makeSimWorld(seed: number, prng: Prng): Promise<SimWorld> {
  const clock = new FakeClock();
  const server = new FakeRemoteServer({ clock, prng: prng.fork("server") });
  const ids = new TestIds(prng.fork("ids"));
  const vaultId = ids.vaultId();
  const ring: Keyring = new FakeKeyring({ vaultId, secret: `sim-${seed}` });
  const boot = server.adapter("simbootstrap0000000000");
  await boot.connect();
  const info = ids.vaultInfo({ vaultId });
  info.params.chunker = { alg: "fastcdc-k1", ...SIM_PARAMS.chunker };
  // A valid infoMac, so engines accept the vault-info (design §4.5.3 step 7).
  const { infoMac: _mac, ...unsigned } = info;
  info.infoMac = await ring.macVaultInfo(unsigned as unknown as Parameters<typeof ring.macVaultInfo>[0]);
  await boot.createVaultInfo(info);
  await boot.close();
  return { seed, clock, server, ring, ids };
}
