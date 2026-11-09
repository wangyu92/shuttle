// Server integration tests run real HTTP/WS servers with fsync'd SQLite on slow disks: longer timeouts,
// and one file at a time so port, CPU and RAM use stay low on the NAS.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@shuttle/server",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
