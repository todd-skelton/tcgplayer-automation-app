import { startInventoryPublicationWorkerProcess } from "../features/inventory-publication/services/inventoryPublicationWorker.server";

console.log(`[publication-worker] starting pid=${process.pid}`);
startInventoryPublicationWorkerProcess();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[publication-worker] received ${signal}; exiting`);
    process.exit(0);
  });
}
