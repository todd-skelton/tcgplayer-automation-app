import { getShippingExportConfig } from "../features/shipping-export/config/shippingExportConfig.server";
import { synchronizeSellerOrders } from "../features/seller-order-history/services/synchronizeSellerOrders.server";

let stopping = false;

async function run(): Promise<void> {
  console.log(`[seller-order-history-worker] starting pid=${process.pid}`);
  while (!stopping) {
    let delayMs = 60_000;
    try {
      const sellerKey = (await getShippingExportConfig()).defaultSellerKey.trim();
      if (sellerKey) {
        const result = await synchronizeSellerOrders(sellerKey);
        console.log(
          `[seller-order-history-worker] ${result.coverage.status} ` +
            `offset=${result.coverage.nextOffset ?? 0} total=${result.coverage.expectedTotal ?? "unknown"}`,
        );
        if (
          result.coverage.status === "incomplete" &&
          result.coverage.error?.startsWith("Sync request budget reached")
        ) {
          delayMs = 2_000;
        } else if (result.coverage.status === "complete") {
          delayMs = 15 * 60_000;
        }
      }
    } catch (error) {
      console.error("[seller-order-history-worker] cycle failed:", error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(`[seller-order-history-worker] received ${signal}; exiting`);
    process.exit(0);
  });
}

void run();
