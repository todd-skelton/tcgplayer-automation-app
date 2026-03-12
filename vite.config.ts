import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  ssr: {
    noExternal: ["@mui/x-data-grid"],
    external: ["pg", "pg-native", "path", "fs", "os"],
  },
  optimizeDeps: {
    include: ["@mui/x-data-grid"],
    exclude: ["pg", "pg-native"],
  },
  build: {
    rollupOptions: {
      external: ["pg", "pg-native", "path", "fs", "os"],
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
