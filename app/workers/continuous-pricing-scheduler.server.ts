import { inventoryPublicationSettingsRepository } from "../core/db/index.server";
import { runContinuousPricingSchedulerCycle } from "../features/continuous-pricing/services/continuousPricingScheduler.server";

let stopping = false;

async function run(): Promise<void> {
  // CONTINUOUS_PRICING_SCHEDULER hands the schedule to the Corten app's scheduler (dev sets it in
  // .env.development.local); two schedulers would queue the same SKUs twice.
  if (process.env.CONTINUOUS_PRICING_SCHEDULER?.trim()) {
    console.log("[continuous-pricing-scheduler] off: CONTINUOUS_PRICING_SCHEDULER is set");
    return;
  }
  console.log(`[continuous-pricing-scheduler] starting pid=${process.pid}`);
  while (!stopping) {
    let delayMs = 30_000;
    try {
      const result = await runContinuousPricingSchedulerCycle();
      const configuration = await inventoryPublicationSettingsRepository.get();
      delayMs =
        configuration.settings.continuousPricing.schedulerPollSeconds * 1_000;
      if (result.status === "scheduled") {
        console.log(
          `[continuous-pricing-scheduler] queued batch=${result.batchNumber} items=${result.itemCount}`,
        );
        delayMs = 0;
      }
    } catch (error) {
      console.error("[continuous-pricing-scheduler] cycle failed:", error);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(delayMs, 1_000));
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[continuous-pricing-scheduler] received ${signal}; exiting`);
    stopping = true;
  });
}

void run();
