import { startInventoryPublicationWorkerProcess } from "../features/inventory-publication/services/inventoryPublicationWorker.server";

// PUBLICATION_WORKER hands publishing to Seller Portal to the Corten app's worker.
if (process.env.PUBLICATION_WORKER?.trim()) {
  console.log("[publication-worker] off: PUBLICATION_WORKER is set");
  process.exit(0);
}
console.log(`[publication-worker] starting pid=${process.pid}`);
startInventoryPublicationWorkerProcess();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[publication-worker] received ${signal}; exiting`);
    process.exit(0);
  });
}
