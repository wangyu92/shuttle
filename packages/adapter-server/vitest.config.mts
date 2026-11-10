// Integration tests start a real @shuttle/server with fsync'd SQLite on slow disks: longer timeouts and
// one file at a time so port, CPU and RAM use stay low on the NAS.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@shuttle/adapter-server",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // design §7.2 H3: every test file's output is scanned for secrets in afterAll.
    setupFiles: ["../testkit/test/h3.setup.ts"],
  },
});
