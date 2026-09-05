import path from "node:path";
import { build } from "esbuild";

await build({
  entryPoints: {
    "slab-evidence-worker": path.resolve(
      "app/workers/slab-evidence-worker.server.ts",
    ),
    "continuous-pricing-scheduler": path.resolve(
      "app/workers/continuous-pricing-scheduler.server.ts",
    ),
    "pricing-worker": path.resolve("app/workers/pricing-worker.server.ts"),
    "publication-worker": path.resolve(
      "app/workers/publication-worker.server.ts",
    ),
  },
  outdir: path.resolve("build/workers"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
  tsconfig: path.resolve("tsconfig.json"),
  logLevel: "info",
});
