import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname!, "ui"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
  },
});
