import {
  startEvidenceWorker,
  stopEvidenceWorker,
} from "../features/ebay-slab-pricing/evidence/evidenceRefreshWorker.server";
import { getPool } from "../core/db/database.server";

console.log(`[slab-evidence-worker] starting pid=${process.pid}`);
startEvidenceWorker();
// Keep the standalone process alive while the shared loop uses unref'd timers.
const alive = setInterval(() => {}, 60_000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(alive);
    void stopEvidenceWorker()
      .finally(() => getPool().end())
      .finally(() => process.exit(0));
  });
