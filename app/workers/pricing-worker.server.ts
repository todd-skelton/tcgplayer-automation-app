import { startInventoryBatchPricingWorkerProcess } from "../features/pending-inventory/services/inventoryBatchPricingWorker.server";

console.log(`[pricing-worker] starting pid=${process.pid}`);
startInventoryBatchPricingWorkerProcess();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[pricing-worker] received ${signal}; exiting`);
    process.exit(0);
  });
}
