// design §7.2 H3: one setup file per project captures every test file's output and scans it for
// secrets in afterAll (suites only register their secrets).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@shuttle/headless",
    setupFiles: ["../testkit/test/h3.setup.ts"],
    // Headless unit tests fsync real files. On a slow disk (about 100-400 ms per fsync) a test that
    // takes 1.5-2.5 s alone can pass 5 s when the full suite shares the disk. Timing only; tests that
    // check engine timing keep their own explicit windows.
    testTimeout: 20_000,
  },
});
