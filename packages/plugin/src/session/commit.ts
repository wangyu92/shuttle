// Persist a finished onboarding (design §5.5.6 "On success": VMKs cached in localStorage, profile
// saved, remoteProfileId computed; UX-D1). Only after every network step succeeded.

import { SERVER_ADAPTER_TYPE } from "../constants";
import { remoteProfileId, type DeviceStore, type Profile } from "../store/localStore";
import type { SetupResult } from "./serverSetup";

export async function commitSetup(store: DeviceStore, r: SetupResult, now: number): Promise<Profile> {
  const id = await remoteProfileId(SERVER_ADAPTER_TYPE, r.vaultId);
  const prev = store.profile(id);
  const profile: Profile = {
    id, adapterType: SERVER_ADAPTER_TYPE, vaultId: r.vaultId, vaultName: r.vaultName,
    endpoints: r.endpoints.map((e) => ({ url: e.url, label: e.label })),
    endpointMode: prev?.endpointMode ?? "auto", allowHttp: r.allowHttp, createdAt: prev?.createdAt ?? now,
  };
  store.saveAuth(id, r.auth);
  store.saveKeys(r.cache);
  store.saveRing(r.vaultId, { activeKv: r.info.activeKv, metaPadBucket: r.info.params.metaPadBucket });
  store.saveProfile(profile);
  store.setActive(id);
  return profile;
}
