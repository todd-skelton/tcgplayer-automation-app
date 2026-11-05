// Node's half of src/features/pricing/parity.rs: prices one batch's SKUs through Node's resolver and
// calculator, then writes the evidence it was served with its answers, so the Rust test prices the
// same SKUs from the same evidence and compares every value.
//
// The evidence is read live once (TCGplayer reads only: latest sales, price history, listings,
// price points), then each run is priced from that recording with the clock held at one moment.
//
//   TZ=UTC WORKERS_RUN_IN_PROCESS=false npx vite-node scripts/parity/pricing-parity.ts <batch> <out.json>
//   PRICING_PARITY=<out.json> cargo test --lib prices_match_node_on_the_same_evidence -- --ignored
//
// tests/fixtures/node/pricing/batch-3471.json is one such recording, which the test reads when
// PRICING_PARITY is unset.
const [batchArg, outArg] = process.argv.slice(2);
if (!batchArg || !outArg) throw new Error("usage: pricing-parity.ts <batch number> <out.json>");
if (process.env.WORKERS_RUN_IN_PROCESS !== "false") {
  throw new Error("Set WORKERS_RUN_IN_PROCESS=false so no worker starts in this process.");
}
// A set's release date is stored without a zone, which JavaScript reads in the local zone; the
// production containers and the Rust port read it as UTC.
if (process.env.TZ !== "UTC") throw new Error("Set TZ=UTC, as the production containers run.");

// Every reading of the clock answers the same moment, as the Rust side is given one `now`.
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
const { inventoryBatchesRepository, pricingConfigRepository, skusRepository } = await import("~/core/db");
const { normalizeServerPricingConfig, pricingCalculatorConfig, normalizeShippingThresholdSnapSettings } =
  await import("~/features/pricing/types/config");
const { PricingCalculator } = await import("~/features/pricing/services/pricingCalculator");
const { PricingBatchApiCache } = await import("~/features/pricing/services/pricingBatchApiCache.server");
const { resolveSuggestedPrice } = await import("~/features/pricing/services/suggestedPriceResolver.server");
const { learnRecentShippingCosts } = await import("~/features/shipping-thresholds/services/shippingThresholds.server");
const { getPricePoints } = await import("~/integrations/tcgplayer/client/get-price-points.server");

type Ask = { condition: string; price: number; shippingCost: number; sellerId: string; sellerKey: string; listingId: number };
type SkuRow = { productId: number; variant?: string | null; language?: string | null; condition: string };

const key = (sku: SkuRow) => `${sku.productId}|${sku.variant ?? ""}|${sku.language ?? ""}`;
const delivered = (ask: Ask) => ask.price + ask.shippingCost;

const batchNumber = Number(batchArg);
const batch = await inventoryBatchesRepository.findByBatchNumber(batchNumber);
if (!batch) throw new Error(`Batch ${batchNumber} not found`);
const items = await inventoryBatchesRepository.findItems(batchNumber, "all");
const bypass = batch.sourceType === "pending_inventory" || batch.sourceType === "strategy";
const skus = items
  .filter((item) => item.sku > 0 && item.totalQuantity + item.addToQuantity > 0)
  .map((item) => ({
    sku: item.sku,
    quantity: item.totalQuantity > 0 ? item.totalQuantity : undefined,
    addToQuantity: item.addToQuantity > 0 ? item.addToQuantity : undefined,
    currentPrice: item.currentPrice ?? undefined,
    bypassProductLineSkips: bypass,
    productLineId: item.productLineId,
    setId: item.setId,
    productId: item.productId,
  }));
const seller = batch.sourceLabel;
const config = normalizeServerPricingConfig(await pricingConfigRepository.get());
const evidenceWindowDays = normalizeShippingThresholdSnapSettings(config.pricing.shippingThresholdSnaps).evidenceWindowDays;
const costModel = await learnRecentShippingCosts(seller, evidenceWindowDays, new Date());
const points = await getPricePoints({ skuIds: skus.map((s) => s.sku) });
const pricePoints = new Map(points.map((p) => [p.skuId, p]));

const sales: Record<string, unknown[]> = {};
const histories: Record<string, unknown[]> = {};
const listings: Record<string, Ask[]> = {};

// The SKU being resolved, so a sales fetch (which carries only ids) is filed under its names.
let current: SkuRow | undefined;
const resolving = (cache: object) => async (input: Parameters<typeof resolveSuggestedPrice>[0]) => {
  current = (await skusRepository.findBySkuAndProductLine(Number(input.tcgplayerId), Number(input.productLineId))) ?? undefined;
  return resolveSuggestedPrice(input, { batchApiCache: cache as InstanceType<typeof PricingBatchApiCache> });
};

// Reads TCGplayer once through Node's own cache and keeps what each read answered.
const live = new PricingBatchApiCache();
const recorder = {
  async fetchLatestSales(...args: Parameters<typeof live.fetchLatestSales>) {
    const read = await live.fetchLatestSales(...args);
    if (current) sales[key(current)] = read;
    return read;
  },
  async fetchPriceHistory(productId: number) {
    const read = await live.fetchPriceHistory(productId);
    histories[String(productId)] = read?.result ?? [];
    return read;
  },
  async fetchListingsForProduct(...args: Parameters<typeof live.fetchListingsForProduct>) {
    const read = await live.fetchListingsForProduct(...args);
    if (read.status === "observed") listings[key(args[0])] = read.listings as Ask[];
    return read;
  },
  fetchLowestListingPrice: (...args: Parameters<typeof live.fetchLowestListingPrice>) => live.fetchLowestListingPrice(...args),
};

// Serves the recording as the Rust test's stand-in serves it.
const replay = (ceilings: Record<string, number | null>) => ({
  async fetchLatestSales() {
    return current ? (sales[key(current)] ?? []) : [];
  },
  async fetchPriceHistory(productId: number) {
    const entries = histories[String(productId)];
    return entries && entries.length > 0 ? { result: entries } : undefined;
  },
  async fetchListingsForProduct(sku: SkuRow & { sku: number }, options: { maxSalesPrice?: number; excludedSellerKey?: string } = {}) {
    ceilings[String(sku.sku)] = options.maxSalesPrice ?? null;
    const ceiling = options.maxSalesPrice;
    return {
      status: "observed",
      listings: (listings[key(sku)] ?? [])
        .filter((ask) => ask.sellerKey !== options.excludedSellerKey)
        .filter((ask) => ceiling === undefined || delivered(ask) <= ceiling),
    };
  },
  async fetchLowestListingPrice(sku: SkuRow, options: { excludedSellerKey?: string } = {}) {
    const ask = (listings[key(sku)] ?? [])
      .filter((a) => a.sellerKey !== options.excludedSellerKey)
      .find((a) => a.condition === sku.condition);
    return ask ? delivered(ask) : undefined;
  },
});

const calculator = new PricingCalculator();
const percentileConfig = { ...config, pricing: { ...config.pricing, policy: { method: "percentile" as const } } };
const runs = [
  { name: "percentile", base: pricingCalculatorConfig(percentileConfig as typeof config, { excludedSellerKey: seller }) },
  { name: "profit-per-day", base: pricingCalculatorConfig(config, { excludedSellerKey: seller }) },
  { name: "profit-per-day-snaps", base: pricingCalculatorConfig(config, { excludedSellerKey: seller, shippingCostModel: costModel }) },
];

console.log(`Recording evidence for ${skus.length} SKUs of batch ${batchNumber}...`);
await calculator.calculatePrices(skus, { ...runs[1].base, suggestedPriceResolver: resolving(recorder) }, pricePoints, "parity");

const recorded = [];
for (const run of runs) {
  const ceilings: Record<string, number | null> = {};
  const result = await calculator.calculatePrices(
    skus,
    { ...run.base, suggestedPriceResolver: resolving(replay(ceilings)) },
    pricePoints,
    "parity",
  );
  const plain = JSON.parse(JSON.stringify(result));
  plain.stats.processingTime = 0;
  recorded.push({ name: run.name, result: plain, ceilings });
  console.log(`${run.name}: ${result.stats.processed} processed, ${result.stats.errors} errors`);
}

writeFileSync(
  outArg,
  JSON.stringify({
    now: new RealDate(NOW).toISOString(),
    seller,
    skus: skus.map(({ sku, productLineId, quantity, addToQuantity, currentPrice, bypassProductLineSkips }) => ({
      sku, productLineId, quantity, addToQuantity, currentPrice, bypassProductLineSkips,
    })),
    marketPrices: Object.fromEntries(points.map((p) => [String(p.skuId), p.marketPrice])),
    sales,
    history: histories,
    listings,
    costModel: JSON.parse(JSON.stringify(costModel ?? null)),
    runs: recorded,
  }),
);
console.log(`Wrote ${outArg}`);
process.exit(0);
