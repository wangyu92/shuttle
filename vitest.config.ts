// Vitest 5 removed vitest.workspace.ts; projects are declared here instead.
// Each packages/* directory is one project, named after its package.json.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    passWithNoTests: true,
  },
});
