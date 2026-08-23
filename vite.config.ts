import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isDemo = mode === "demo";

  return {
    root: isDemo ? "demo" : ".",
    resolve: {
      alias: {
        "@": resolve(__dirname, "ui"),
      },
    },
    build: {
      outDir: isDemo ? resolve(__dirname, "demo/dist") : "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: isDemo
          ? { demo: resolve(__dirname, "demo/index.html") }
          : {
              main: resolve(__dirname, "index.html"),
              overlay: resolve(__dirname, "overlay.html"),
              bsb: resolve(__dirname, "bsb.html"),
            },
      },
    },
    base: isDemo ? "/nagents/" : "/",
    server: {
      port: isDemo ? 5181 : 5180,
      strictPort: true,
    },
  };
});
