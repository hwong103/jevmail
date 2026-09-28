import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts on purpose. Vitest 4 forces
// `resolve.external` onto every environment, which the Cloudflare *Vite plugin*
// rejects for Worker environments. Running the pool on its own avoids that
// validation entirely, and the dev server keeps the plugin it needs.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
