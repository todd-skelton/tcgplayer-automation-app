// Grades the curve's sell-time forecast and the buyer-choice forecast against
// realized sales of the modeled inventory.
//
//   npm run pricing:grade-forecasts -- --from <batch> [--to <batch>] [--horizon 21]
//
// Results priced under the target-horizon policy are left out: that policy
// pins the curve forecast to its horizon wherever the curve reaches it, so
// there is nothing to grade.
import { parseArgs } from "node:util";
import { loadAppEnv } from "./load-local-env.mjs";
import {
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
  inventoryStrategyRepository,
} from "../app/core/db/index.server";
import { getPool } from "../app/core/db/database.server";
import { BUYER_CHOICE_CALIBRATION } from "../app/features/pricing/algorithms/buyerChoiceSellTime";
import {
  buildCohort,
  gradeForecast,
  type ForecastRecord,
} from "../app/features/pricing/domain/forecastGrading";

loadAppEnv(process.env.NODE_ENV);

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    horizon: { type: "string", default: "21" },
  },
});
const from = Number(values.from);
const horizonDays = Number(values.horizon);
if (!Number.isInteger(from) || !(horizonDays > 0)) {
  console.error(
    "Usage: npm run pricing:grade-forecasts -- --from <batch> [--to <batch>] [--horizon 21]",
  );
  process.exit(1);
}

const FORECAST_NAMES = ["curve", "buyer-choice"] as const;
const percent = (share: number) => `${(100 * share).toFixed(1)}%`;

try {
  const to = values.to
    ? Number(values.to)
    : ((
        await inventoryBatchesRepository.findRecent({
          sourceTypes: [
            "continuous",
            "strategy",
            "pending_inventory",
            "seller",
            "csv",
          ],
          limit: 1,
        })
      )[0]?.batchNumber ?? from);
  const records: ForecastRecord[] = [];
  let otherCalibrations = 0;
  for (let batch = from; batch <= to; batch += 1) {
    for (const result of await inventoryBatchesRepository.findResults(
      batch,
      "successful",
    )) {
      const details = result.pricingDetails;
      if (!details?.pricedAt || !((details.quantity ?? 0) > 0)) continue;
      const forecasts: Record<string, number> = {};
      const decision = details.decision;
      if (
        decision?.basis === "modeled" &&
        decision.method !== "target-horizon" &&
        (decision.estimatedMedianSellDays ?? 0) > 0
      ) {
        forecasts.curve = decision.estimatedMedianSellDays!;
      }
      const choice = details.buyerChoiceForecast;
      if (choice && choice.calibration !== BUYER_CHOICE_CALIBRATION.name) {
        otherCalibrations += 1;
      } else if (choice && choice.medianSellDays > 0) {
        forecasts["buyer-choice"] = choice.medianSellDays;
      }
      records.push({
        sku: result.sku,
        pricedAt: new Date(details.pricedAt).getTime(),
        quantity: details.quantity!,
        forecasts,
      });
    }
  }
  if (records.length === 0) {
    console.error(`No successful results in batches ${from} to ${to}.`);
    process.exit(1);
  }
  const { sellerKey } = (await inventoryPublicationSettingsRepository.get())
    .settings.continuousPricing;
  if (!sellerKey) {
    console.error(
      "Continuous pricing has no seller key, so the in-stock snapshot is unavailable.",
    );
    process.exit(1);
  }
  const inStock = new Set(
    (await inventoryStrategyRepository.findSnapshot(sellerKey)).map(
      (item) => item.sku,
    ),
  );
  const cohort = buildCohort(records, FORECAST_NAMES, inStock, horizonDays);
  console.log(
    `batches ${from} to ${to}: ${records.length} results, cohort ${cohort.length} SKUs with ${horizonDays} days of exposure` +
      (otherCalibrations
        ? `, ${otherCalibrations} results from other calibrations skipped`
        : ""),
  );
  if (cohort.length === 0) {
    console.error("No SKU carries both forecasts with enough exposure yet.");
    process.exit(1);
  }
  const soldShare =
    cohort.filter((member) => member.sold).length / cohort.length;
  console.log(
    `sold ${percent(soldShare)}; base-rate Brier ${(soldShare * (1 - soldShare)).toFixed(4)}`,
  );
  for (const name of FORECAST_NAMES) {
    const grade = gradeForecast(cohort, name, horizonDays);
    console.log(`\n${name}: Brier ${grade.brier.toFixed(4)}`);
    console.log("  decile  median forecast days   sold%  expected%");
    grade.deciles.forEach((decile, index) => {
      console.log(
        `  ${String(index + 1).padStart(6)}  ${decile.medianDays.toFixed(0).padStart(20)}  ${percent(decile.soldShare).padStart(6)}  ${percent(decile.expectedShare).padStart(9)}`,
      );
    });
  }
} finally {
  await getPool().end();
}
