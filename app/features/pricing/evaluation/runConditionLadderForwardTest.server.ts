/**
 * Runs the condition ladder forward test over the ledgers.
 *
 *   npm run evaluate:condition-ladder                    reads DATABASE_URL
 *   npm run evaluate:condition-ladder -- --input <dir>   reads exports
 *
 * The export directory holds sales.json, weekly-sales.json, and
 * listing-snapshots.json, each a JSON array of rows, for example from production:
 *   docker exec tcgplayer-postgres-prod psql -U postgres -d tcgplayer_automation -At \
 *     -c "SELECT json_agg(row_to_json(s)) FROM product_sales s" > sales.json
 *   ... FROM product_weekly_sales s  > weekly-sales.json
 *   ... FROM product_listing_snapshots s > listing-snapshots.json
 */
import fs from "node:fs";
import path from "node:path";
import type { ListingSnapshot } from "~/core/db/repositories/productListingSnapshots.server";
import type { RecordedSale } from "~/core/db/repositories/productSales.server";
import type { WeeklySales } from "~/core/db/repositories/productWeeklySales.server";
import {
  CANDIDATES,
  runConditionLadderForwardTest,
  summarizeForwardTest,
  weeklyCutoffs,
  type ForwardTestData,
  type ForwardTestSummary,
} from "./conditionLadderForwardTest";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readRows<Row>(file: string): Row[] {
  if (!fs.existsSync(file)) return [];
  // psql prints nothing for an empty table, and json_agg of no rows is null.
  const text = fs.readFileSync(file, "utf8").trim();
  return (text ? (JSON.parse(text) as Row[] | null) : null) ?? [];
}

const number = (value: unknown): number | null => {
  const parsed = Number(value);
  return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed;
};

function readExports(directory: string): ForwardTestData {
  const sales = readRows<Record<string, unknown>>(path.join(directory, "sales.json")).map(
    (row): RecordedSale => ({
      productId: Number(row.product_id),
      orderDate: String(row.order_date),
      condition: row.condition as RecordedSale["condition"],
      variant: String(row.variant ?? "") as RecordedSale["variant"],
      language: String(row.language ?? "") as RecordedSale["language"],
      quantity: Number(row.quantity),
      purchasePrice: Number(row.purchase_price),
      shippingPrice: Number(row.shipping_price),
      listingType: row.listing_type as RecordedSale["listingType"],
      customListingId: String(row.custom_listing_id ?? ""),
      title: "",
    }),
  );
  const weeklySales = readRows<Record<string, unknown>>(path.join(directory, "weekly-sales.json")).map(
    (row): WeeklySales => ({
      productId: Number(row.product_id),
      skuId: Number(row.sku_id),
      condition: row.condition as WeeklySales["condition"],
      variant: String(row.variant ?? ""),
      language: String(row.language ?? ""),
      weekStart: String(row.week_start).slice(0, 10),
      transactions: Number(row.transactions),
      quantity: Number(row.quantity),
      lowSalePrice: number(row.low_sale_price),
      highSalePrice: number(row.high_sale_price),
      lowSalePriceWithShipping: number(row.low_sale_price_with_shipping),
      highSalePriceWithShipping: number(row.high_sale_price_with_shipping),
      tcgMarketPrice: number(row.tcg_market_price),
    }),
  );
  const listingSnapshots = readRows<Record<string, unknown>>(
    path.join(directory, "listing-snapshots.json"),
  ).map(
    (row): ListingSnapshot => ({
      productId: Number(row.product_id),
      variant: String(row.variant ?? ""),
      language: String(row.language ?? ""),
      condition: row.condition as ListingSnapshot["condition"],
      observedOn: String(row.observed_on).slice(0, 10),
      sellerCount: Number(row.seller_count),
      cheapestDeliveredPrice: number(row.cheapest_delivered_price),
      secondCheapestDeliveredPrice: number(row.second_cheapest_delivered_price),
    }),
  );
  return { sales, weeklySales, listingSnapshots };
}

async function loadData(): Promise<ForwardTestData> {
  const input = argument("input");
  if (input) return readExports(input);
  const {
    productListingSnapshotsRepository,
    productSalesRepository,
    productWeeklySalesRepository,
  } = await import("~/core/db");
  const since = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const [sales, weeklySales, listingSnapshots] = await Promise.all([
    productSalesRepository.findSince(since),
    productWeeklySalesRepository.findSince(since),
    productListingSnapshotsRepository.findSince(since),
  ]);
  return { sales, weeklySales, listingSnapshots };
}

const percent = (value: number | undefined) =>
  value === undefined ? "      " : `${(value * 100).toFixed(1).padStart(5)}%`;

function printSummary(summaries: ForwardTestSummary[]) {
  for (const scenario of ["seen", "unseen"] as const) {
    const rows = summaries.filter((row) => row.scenario === scenario);
    if (rows.length === 0) continue;
    console.log(
      scenario === "seen"
        ? "\nCondition seen in the evidence:"
        : "\nCondition unseen (its own sales, weeks, and market price removed; asks kept):",
    );
    console.log(
      `  ${"condition".padEnd(18)} ${"candidate".padEnd(20)} ${"n".padStart(6)}  median err   bias   within 10%  beats production`,
    );
    const conditions = ["all", ...new Set(rows.map((row) => row.condition).filter((c) => c !== "all"))];
    for (const condition of conditions) {
      for (const candidate of CANDIDATES) {
        const row = rows.find((r) => r.condition === condition && r.candidate === candidate);
        if (!row) continue;
        console.log(
          `  ${condition.padEnd(18)} ${candidate.padEnd(20)} ${String(row.count).padStart(6)}  ${percent(row.medianRelativeError)}   ${percent(row.medianSignedError)}   ${percent(row.withinTenPercent)}     ${percent(row.betterThanProduction)}`,
        );
      }
    }
  }
}

async function main() {
  const data = await loadData();
  const horizonDays = Number(argument("horizon-days") ?? 14);
  const cutoffs = weeklyCutoffs(data.sales, { horizonDays });
  const products = new Set(data.sales.map((sale) => sale.productId)).size;
  console.log(
    `${data.sales.length} recorded sales across ${products} products, ${data.weeklySales.length} traded weeks, ${data.listingSnapshots.length} listing snapshots, ${cutoffs.length} weekly cutoffs, ${horizonDays}-day horizon`,
  );
  if (cutoffs.length === 0) {
    console.log("Not enough recorded sales yet: the test needs a horizon of sales after the first cutoff.");
    return;
  }
  const scores = runConditionLadderForwardTest(data, { cutoffs, horizonDays });
  printSummary(summarizeForwardTest(scores));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
