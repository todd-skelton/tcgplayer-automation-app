import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  ssr: {
    noExternal: ["@mui/x-data-grid"],
    external: ["nedb-promises", "@seald-io/nedb", "path", "fs", "os"],
  },
  optimizeDeps: {
    include: ["@mui/x-data-grid"],
    exclude: ["nedb-promises", "@seald-io/nedb"],
  },
  build: {
    rollupOptions: {
      external: ["nedb-promises", "@seald-io/nedb", "path", "fs", "os"],
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
