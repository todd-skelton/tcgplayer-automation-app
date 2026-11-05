import {
  startEvidenceWorker,
  stopEvidenceWorker,
} from "../features/ebay-slab-pricing/evidence/evidenceRefreshWorker.server";
import { getPool } from "../core/db/database.server";

// SLAB_EVIDENCE_WORKER hands the evidence queue and slab maintenance to the Corten app's worker.
if (process.env.SLAB_EVIDENCE_WORKER?.trim()) {
  console.log("[slab-evidence-worker] off: SLAB_EVIDENCE_WORKER is set");
  process.exit(0);
}
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
