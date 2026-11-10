// Vault manifest for cutover stage 1 (design §6.2.2 step 1): one line per file, `path\tsize\tsha256`,
// sorted by path, the same format as `shuttle-headless manifest`. Read-only: nothing in the vault is
// written. The config folder and `.trash` are left out, as on the NAS mirror (which has neither).

export interface ManifestAdapter {
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export type Digest = (data: ArrayBuffer) => Promise<ArrayBuffer>;

const sha256: Digest = (data) => crypto.subtle.digest("SHA-256", data);

function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function skipped(path: string, configDir: string): boolean {
  const top = path.split("/")[0] ?? "";
  return top === configDir || top === ".trash";
}

export async function buildManifest(
  adapter: ManifestAdapter,
  configDir: string,
  digest: Digest = sha256,
  onProgress?: (files: number) => void,
): Promise<{ text: string; files: number }> {
  const rows: Array<[string, string]> = [];
  const queue = [""];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const { files, folders } = await adapter.list(dir === "" ? "/" : dir);
    for (const f of folders) {
      const p = f.replace(/^\/+/, "");
      if (!skipped(p, configDir)) queue.push(p);
    }
    for (const f of files) {
      const p = f.replace(/^\/+/, "");
      if (skipped(p, configDir)) continue;
      const data = await adapter.readBinary(p);
      rows.push([p, `${p}\t${data.byteLength}\t${hex(await digest(data))}`]);
      if (onProgress && rows.length % 200 === 0) onProgress(rows.length);
    }
  }
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const text = rows.map((r) => r[1]).join("\n") + (rows.length ? "\n" : "");
  return { text, files: rows.length };
}
