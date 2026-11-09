// Per-device storage in Obsidian's vault-scoped localStorage (design UX-D6, §4.10.1, §3.3.5).
// `app.loadLocalStorage` / `app.saveLocalStorage` are synchronous and survive a force-quit (P0 M12);
// nothing here goes to data.json. Every read tolerates missing or malformed values.

import type { DeviceSettings } from "@shuttle/protocol";
import { sha256hex, type CachedSecrets, type Seen } from "@shuttle/crypto";
import type { LocalRecord, LocalRecordStore, SeenStore } from "@shuttle/engine";
import { SERVER_ADAPTER_TYPE } from "../constants";

/** The two calls Obsidian's App offers (null deletes). */
export interface KvStore {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export const LS = {
  profiles: "shuttle:v1:profiles",
  activeProfile: "shuttle:v1:activeProfile",
  settings: "shuttle:v1:settings",
  welcomed: "shuttle:v1:welcomed",
  auth: (profileId: string) => `shuttle:v1:profile:${profileId}:auth`,
  local: (profileId: string) => `shuttle:v1:profile:${profileId}:local`,
  firstSync: (profileId: string) => `shuttle:v1:profile:${profileId}:firstSyncDone`,
  keys: (vaultId: string) => `shuttle:v1:vault:${vaultId}:keys`,
  ring: (vaultId: string) => `shuttle:v1:vault:${vaultId}:ring`,
  seen: (vaultId: string) => `shuttle:v1:vault:${vaultId}:seen`,
} as const;

export interface Endpoint { url: string; label: string }

/** A remote profile = one remote vault (design UX-D1). No secrets. */
export interface Profile {
  id: string;                       // remoteProfileId
  adapterType: typeof SERVER_ADAPTER_TYPE;
  vaultId: string;
  vaultName: string;
  endpoints: Endpoint[];
  endpointMode: "auto" | number;    // index into endpoints when pinned
  allowHttp: boolean;
  createdAt: number;
}

/** Device token and id (design §4.10.1 `…:auth`). */
export interface AuthRecord { token: string; deviceId: string; username?: string; owner?: boolean }

/** Non-secret keyring parameters used to start offline from cached keys (headless does the same). */
export interface RingParams { activeKv: number; metaPadBucket: number }

/** design UX-D1: remoteProfileId = sha256(adapterType + ":" + vaultId)[0..16] hex. */
export async function remoteProfileId(adapterType: string, vaultId: string): Promise<string> {
  return (await sha256hex(new TextEncoder().encode(`${adapterType}:${vaultId}`))).slice(0, 16);
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readProfile(v: unknown): Profile | null {
  const o = obj(v);
  if (!o) return null;
  if (typeof o["id"] !== "string" || typeof o["vaultId"] !== "string" || !Array.isArray(o["endpoints"])) return null;
  const endpoints: Endpoint[] = [];
  for (const e of o["endpoints"] as unknown[]) {
    const eo = obj(e);
    if (eo && typeof eo["url"] === "string") endpoints.push({ url: eo["url"], label: typeof eo["label"] === "string" ? eo["label"] : "" });
  }
  if (endpoints.length === 0) return null;
  const mode = o["endpointMode"];
  return {
    id: o["id"], adapterType: SERVER_ADAPTER_TYPE, vaultId: o["vaultId"],
    vaultName: typeof o["vaultName"] === "string" ? o["vaultName"] : o["vaultId"],
    endpoints,
    endpointMode: typeof mode === "number" && mode >= 0 && mode < endpoints.length ? mode : "auto",
    allowHttp: o["allowHttp"] === true,
    createdAt: typeof o["createdAt"] === "number" ? o["createdAt"] : 0,
  };
}

/** Typed access to every localStorage record the plugin keeps. */
export class DeviceStore {
  constructor(readonly kv: KvStore) {}

  // ---------- profiles ----------
  profiles(): Profile[] {
    const v = this.kv.load(LS.profiles);
    return Array.isArray(v) ? v.map(readProfile).filter((p): p is Profile => p !== null) : [];
  }
  profile(id: string): Profile | null {
    return this.profiles().find((p) => p.id === id) ?? null;
  }
  saveProfile(p: Profile): void {
    const list = this.profiles().filter((x) => x.id !== p.id);
    list.push(p);
    this.kv.save(LS.profiles, list);
  }
  activeProfile(): Profile | null {
    const id = this.kv.load(LS.activeProfile);
    return typeof id === "string" ? this.profile(id) : null;
  }
  setActive(id: string | null): void {
    this.kv.save(LS.activeProfile, id);
  }

  // ---------- secrets (design §4.10.1) ----------
  auth(profileId: string): AuthRecord | null {
    const o = obj(this.kv.load(LS.auth(profileId)));
    if (!o || typeof o["token"] !== "string" || typeof o["deviceId"] !== "string") return null;
    return {
      token: o["token"], deviceId: o["deviceId"],
      ...(typeof o["username"] === "string" ? { username: o["username"] } : {}),
      ...(typeof o["owner"] === "boolean" ? { owner: o["owner"] } : {}),
    };
  }
  saveAuth(profileId: string, a: AuthRecord): void {
    this.kv.save(LS.auth(profileId), a);
  }
  keys(vaultId: string): CachedSecrets | null {
    const o = obj(this.kv.load(LS.keys(vaultId)));
    const kvs = obj(o?.["kvs"]);
    if (!o || o["vaultId"] !== vaultId || !kvs) return null;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(kvs)) if (/^[1-9][0-9]*$/.test(k) && typeof v === "string") out[Number(k)] = v;
    return Object.keys(out).length ? { vaultId, kvs: out } : null;
  }
  saveKeys(c: CachedSecrets): void {
    this.kv.save(LS.keys(c.vaultId), { vaultId: c.vaultId, kvs: { ...c.kvs } });
  }
  dropKeys(vaultId: string): void {
    this.kv.save(LS.keys(vaultId), null);
  }
  ring(vaultId: string): RingParams | null {
    const o = obj(this.kv.load(LS.ring(vaultId)));
    if (!o || typeof o["activeKv"] !== "number" || typeof o["metaPadBucket"] !== "number") return null;
    return { activeKv: o["activeKv"], metaPadBucket: o["metaPadBucket"] };
  }
  saveRing(vaultId: string, r: RingParams): void {
    this.kv.save(LS.ring(vaultId), r);
  }

  // ---------- engine records ----------
  localRecordStore(profileId: string): LocalRecordStore {
    return {
      load: () => {
        const o = obj(this.kv.load(LS.local(profileId)));
        if (!o || typeof o["deviceId"] !== "string" || typeof o["dbEpoch"] !== "string") return null;
        return {
          deviceId: o["deviceId"], dbEpoch: o["dbEpoch"],
          remoteProfileId: typeof o["remoteProfileId"] === "string" && o["remoteProfileId"] ? o["remoteProfileId"] : profileId,
          everSynced: o["everSynced"] === true,
          pendingOps: Array.isArray(o["pendingOps"]) ? (o["pendingOps"] as LocalRecord["pendingOps"]) : [],
        };
      },
      save: (r: LocalRecord) => this.kv.save(LS.local(profileId), { ...r, remoteProfileId: r.remoteProfileId || profileId }),
    };
  }
  seenStore(vaultId: string): SeenStore {
    return {
      load: () => {
        const o = obj(this.kv.load(LS.seen(vaultId)));
        if (!o) return null;
        const n = (k: string): number | null => (typeof o[k] === "number" ? (o[k] as number) : null);
        const epoch = n("epoch"), infoRev = n("infoRev"), activeKv = n("activeKv"), maxSeq = n("maxSeq");
        if (epoch === null || infoRev === null || activeKv === null || maxSeq === null) return null;
        const s: Seen = { epoch, infoRev, activeKv, maxSeq };
        if (typeof o["maxEntryKey"] === "number" || o["maxEntryKey"] === null) s.maxEntryKey = o["maxEntryKey"] as number | null;
        return s;
      },
      save: (s: Seen) => this.kv.save(LS.seen(vaultId), { ...s }),
    };
  }

  // ---------- per-device settings ----------
  settings(): Partial<DeviceSettings> {
    return (obj(this.kv.load(LS.settings)) ?? {}) as Partial<DeviceSettings>;
  }
  saveSettings(s: Partial<DeviceSettings>): void {
    this.kv.save(LS.settings, s);
  }

  flag(key: string): boolean {
    return this.kv.load(key) === true;
  }
  setFlag(key: string, v: boolean): void {
    this.kv.save(key, v ? true : null);
  }

  /** design §5.4 E10 "Reset this device": forget every profile, credential and key. */
  forgetAll(): void {
    for (const p of this.profiles()) {
      for (const k of [LS.auth(p.id), LS.local(p.id), LS.firstSync(p.id), LS.keys(p.vaultId), LS.ring(p.vaultId), LS.seen(p.vaultId)]) this.kv.save(k, null);
    }
    this.kv.save(LS.profiles, null);
    this.kv.save(LS.activeProfile, null);
  }
}

/** In-memory KvStore (tests, and a fallback when the API is missing). */
export class MemKv implements KvStore {
  readonly m = new Map<string, unknown>();
  load(key: string): unknown {
    const v = this.m.get(key);
    return v === undefined ? null : structuredClone(v);
  }
  save(key: string, value: unknown): void {
    if (value === null || value === undefined) this.m.delete(key);
    else this.m.set(key, structuredClone(value));
  }
}
