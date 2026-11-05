// @shuttle/server: Own sync server (design 2.8). AGPL-3.0-only.
// CLI entry for dist/server/shuttle-server.mjs. P0: dev stub only (see ./server.ts).
// Env: SHUTTLE_HOST (127.0.0.1; 0.0.0.0 when SHUTTLE_DATA=/data, i.e. inside the §2.8.9 container), SHUTTLE_PORT (8787), SHUTTLE_DATA (~/tmp/claude/shuttle-dev-data),
//      SHUTTLE_MAX_BLOB (bytes), SHUTTLE_SOURCE_URL (the "source" field of /v1/health, §8.6).
import os from "node:os";
import path from "node:path";
import { startServer } from "./server";

export const PACKAGE_NAME = "@shuttle/server";

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${v}`);
  return n;
}

const env = process.env;
const dataDir = expandHome(env.SHUTTLE_DATA || path.join(os.homedir(), "tmp/claude/shuttle-dev-data"));
const maxBlob = env.SHUTTLE_MAX_BLOB ? intEnv("SHUTTLE_MAX_BLOB", 0) : undefined;

const server = await startServer({
  // In the container the published port 127.0.0.1:8787:8787 needs the server on all interfaces.
  host: env.SHUTTLE_HOST || (env.SHUTTLE_DATA === "/data" ? "0.0.0.0" : "127.0.0.1"),
  port: intEnv("SHUTTLE_PORT", 8787),
  dataDir,
  ...(maxBlob !== undefined ? { maxBlobSize: maxBlob } : {}),
  ...(env.SHUTTLE_SOURCE_URL ? { sourceUrl: env.SHUTTLE_SOURCE_URL } : {}),
  log: (m) => console.log(m),
});

let stopping = false;
const stop = (sig: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: shutting down`);
  server.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
