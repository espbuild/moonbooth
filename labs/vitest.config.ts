import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the SDK's TypeScript source so the harness
      // suite does not depend on a prior build of the published package.
      "@moonbooth/sdk": fileURLToPath(
        new URL("../packages/sdk-typescript/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
