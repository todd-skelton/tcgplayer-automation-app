import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

function shouldIgnoreBuildWarning(warning: { code?: string; id?: string; message?: string }) {
  const message = warning.message ?? "";
  const id = warning.id ?? "";

  if (
    warning.code === "EMPTY_BUNDLE" &&
    message.startsWith('Generated an empty chunk: "api.')
  ) {
    return true;
  }

  if (
    (id.includes("@mui/x-data-grid/esm/hooks/utils") ||
      message.includes("node_modules/@mui/x-data-grid/esm/hooks/utils")) &&
    (message.includes("Ambiguous external namespace resolution") ||
      message.includes("are imported from external module"))
  ) {
    return true;
  }

  return false;
}

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
      onwarn(warning, defaultHandler) {
        if (shouldIgnoreBuildWarning(warning)) {
          return;
        }

        defaultHandler(warning);
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
