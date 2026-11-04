// Node's half of src/features/batch_pricing/saved_curves.rs's cached-run test: prices a continuous
// batch from its SKUs' saved curves (mode "cached") as Node's worker would, nothing saved, with
// the clock held at one moment, and writes the job's configuration, the moment and what it priced.
//
// A cached run makes the batch's SKUs whose curves are stale due again, as the worker does; the
// SKUs of a batch priced within the schedule's interval have none stale.
//
//   TZ=UTC WORKERS_RUN_IN_PROCESS=false npx vite-node scripts/parity/cached-run.ts <batch> <out.json>
//   CACHED_RUN=<out.json> cargo test --lib a_cached_run_prices_as_node_s_does -- --ignored
const [batchArg, outArg] = process.argv.slice(2);
if (!batchArg || !outArg) throw new Error("usage: cached-run.ts <batch number> <out.json>");
if (process.env.WORKERS_RUN_IN_PROCESS !== "false") {
  throw new Error("Set WORKERS_RUN_IN_PROCESS=false so no worker starts in this process.");
}
if (process.env.TZ !== "UTC") throw new Error("Set TZ=UTC, as the production containers run.");

const NOW = Date.now();
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: ConstructorParameters<DateConstructor> | []) {
    if (args.length === 0) super(NOW);
    else super(...(args as ConstructorParameters<DateConstructor>));
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FrozenDate as DateConstructor;

export {};

const { writeFileSync } = await import("node:fs");
const { queryOne } = await import("~/core/db/database.server");
const { executeInventoryBatchPricingJob } = await import(
  "~/features/pending-inventory/services/inventoryBatchPricing.server"
);

const batchNumber = Number(batchArg);
// The configuration the batch's latest job was queued with, as a cached repricing of it would be.
const job = await queryOne<{ config: Record<string, unknown> }>(
  "SELECT config_json AS config FROM inventory_batch_pricing_jobs WHERE batch_number = $1 ORDER BY id DESC LIMIT 1",
  [batchNumber],
);
if (!job) throw new Error(`Batch ${batchNumber} has no pricing job`);

const result = await executeInventoryBatchPricingJob({
  batchNumber,
  mode: "cached",
  config: job.config as never,
});
writeFileSync(
  outArg,
  JSON.stringify(
    {
      batchNumber,
      asOf: new RealDate(NOW).toISOString(),
      config: job.config,
      pricedSkus: result.pricedSkus,
      summary: result.summary,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Priced ${result.pricedSkus.length} SKUs of batch ${batchNumber} from saved curves; wrote ${outArg}`);
process.exit(0);
