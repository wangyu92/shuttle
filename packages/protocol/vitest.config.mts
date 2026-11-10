// design §7.2 H3: one setup file per project captures every test file's output and scans it for
// secrets in afterAll (suites only register their secrets).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@shuttle/protocol",
    setupFiles: ["./test/h3.setup.ts"],
  },
});
