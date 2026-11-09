// The `obsidian` package ships type declarations only (no runtime JS), so plugin tests resolve it to
// a stub. Extend test/obsidian-stub.ts when a test needs more of the API.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)) },
  },
  test: {
    name: "shuttle",
    passWithNoTests: true,
  },
});
