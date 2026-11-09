// @shuttle/server: own sync server (design §2.8). AGPL-3.0-only.
// CLI entry for dist/server/shuttle-server.mjs. Configuration comes from the environment (config.ts):
// SHUTTLE_DATA, SHUTTLE_HOST, SHUTTLE_PORT, SHUTTLE_TRUST_PROXY, SHUTTLE_PUBLIC_URL, SHUTTLE_ALLOWED_ORIGINS,
// SHUTTLE_SOURCE_URL, SHUTTLE_MAX_BLOB, SHUTTLE_MAX_PACK, SHUTTLE_MAX_COMMIT_BYTES, SHUTTLE_MAX_COMMIT_OPS,
// SHUTTLE_MAX_FILE, SHUTTLE_MAX_REQUEST_BODY.
import { optionsFromEnv } from "./config";
import { startServer } from "./server";

export const PACKAGE_NAME = "@shuttle/server";

const server = await startServer(optionsFromEnv());

let stopping = false;
const stop = (sig: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: shutting down`);
  // design §2.8.9 stop_grace_period 20 s: close sockets 4503, write hwm, checkpoint WAL.
  const force = setTimeout(() => process.exit(1), 18_000);
  force.unref();
  server.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
