import assert from "node:assert/strict";
import {
  FORECAST_CORRECTION_METHOD,
  learnForecastCorrection,
  learnMultiplier,
  measureListedPrice,
  type ListedPrice,
  type SkuSale,
} from "./forecastCorrectionModel";

const DAY_MS = 86_400_000;
const day = (value: number) => new Date(Date.UTC(2026, 8, 1) + value * DAY_MS);
/** A median of 2 ln 2 days forecasts half a sale per day in stock. */
const HALF_A_SALE_PER_DAY = 2 * Math.LN2;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const listed = (changes: Partial<ListedPrice> = {}): ListedPrice => ({
  sku: 1,
  productLineId: 3,
  productLine: "Pokemon",
  countedAt: day(0),
  listedAt: day(0),
  replacedAt: day(4),
  quantity: 1,
  forecastMedianSellDays: HALF_A_SALE_PER_DAY,
  ...changes,
});
const sold = (at: number, quantity = 1, sku = 1): SkuSale => ({ sku, soldAt: day(at), quantity });

{
  const time = measureListedPrice(listed(), [sold(2)], day(10));
  close(time.inStockDays, 2);
  assert.equal(time.sales, 1);
  close(time.forecastSales, 1);

  const replaced = measureListedPrice(listed(), [sold(5)], day(10));
  close(replaced.inStockDays, 4);
  assert.equal(replaced.sales, 0, "a sale after the next price belongs to that price");

  const current = measureListedPrice(listed({ replacedAt: null }), [], day(3));
  close(current.inStockDays, 3);

  const goneBeforeListing = measureListedPrice(listed({ listedAt: day(1) }), [sold(0.5)], day(10));
  assert.equal(goneBeforeListing.inStockDays, 0, "copies sold after the count were gone before listing");
  assert.equal(goneBeforeListing.sales, 0);

  const twoCopies = measureListedPrice(listed({ quantity: 2 }), [sold(1), sold(3)], day(10));
  assert.equal(twoCopies.sales, 2);
  close(twoCopies.inStockDays, 3);

  const boughtTogether = measureListedPrice(listed({ quantity: 2 }), [sold(1, 2), sold(2)], day(10));
  assert.equal(boughtTogether.sales, 1, "one order is one buyer, however many copies it took");
  close(boughtTogether.inStockDays, 1);
  console.log("PASS listed prices are measured by time in stock until replaced or sold out");
}

{
  close(learnMultiplier({ listings: 1, inStockDays: 1, sales: 50, forecastSales: 100 }), 120 / 70);
  close(learnMultiplier({ listings: 1, inStockDays: 1, sales: 0, forecastSales: 0 }, 1.5), 1.5);
  assert.equal(learnMultiplier({ listings: 1, inStockDays: 1, sales: 0, forecastSales: 500 }), 3);
  assert.equal(learnMultiplier({ listings: 1, inStockDays: 1, sales: 500, forecastSales: 1 }), 0.5);
  console.log("PASS multipliers lean on pseudo-sales at the prior and stay within bounds");
}

/**
 * Each day each line lists eight one-day prices forecast at half a sale each.
 * Every price sells or not according to the line's sales per forecast sale.
 */
function market(lines: Array<{ productLineId: number; salesPerForecast: (listedDay: number) => number }>) {
  const prices: ListedPrice[] = [];
  const sales: SkuSale[] = [];
  for (const line of lines) {
    for (let listedDay = 0; listedDay < 40; listedDay += 1) {
      const sellingCopies = Math.round(8 * 0.5 * line.salesPerForecast(listedDay));
      for (let copy = 0; copy < 8; copy += 1) {
        const sku = line.productLineId * 100_000 + listedDay * 100 + copy;
        prices.push(listed({
          sku,
          productLineId: line.productLineId,
          productLine: `Line ${line.productLineId}`,
          countedAt: day(listedDay),
          listedAt: day(listedDay),
          replacedAt: day(listedDay + 1),
          quantity: 5,
        }));
        if (copy < sellingCopies) sales.push(sold(listedDay + 0.5, 1, sku));
      }
    }
  }
  return learnForecastCorrection({
    sellerKey: "seller",
    prices,
    sales,
    from: day(0),
    through: day(40),
    learnedAt: day(40),
    evidenceWindowDays: 40,
  });
}

{
  const report = market([
    { productLineId: 1, salesPerForecast: () => 0.5 },
    { productLineId: 2, salesPerForecast: () => 1 },
  ]);
  assert.equal(report.heldOutFrom, day(30).toISOString());
  assert.equal(report.overall.fit.sales, 180);
  close(report.overall.fit.forecastSales, 240);
  assert.equal(report.overall.status, "applied");
  assert.equal(report.overall.fitMultiplier, 1.3);
  assert.equal(report.overall.medianDaysMultiplier, Math.round(((320 + 20) / (240 + 20)) * 1000) / 1000);
  const [slow, steady] = [1, 2].map((id) => report.productLines.find((line) => line.productLineId === id)!);
  assert.equal(slow.status, "applied");
  assert.equal(slow.baselineMultiplier, 1.3);
  assert.ok(slow.medianDaysMultiplier! > 1.8, "the slow line waits about twice the forecast");
  assert.equal(steady.status, "applied");
  assert.ok(steady.medianDaysMultiplier! < 1.1, "the steady line keeps close to the forecast");
  assert.ok(report.correction);
  assert.ok(report.correction.version.startsWith(`${FORECAST_CORRECTION_METHOD}@`));
  assert.equal(report.correction.sellerKey, "seller");
  assert.equal(report.correction.medianDaysMultiplier, report.overall.medianDaysMultiplier);
  assert.deepEqual(report.correction.productLineMedianDaysMultipliers, {
    1: slow.medianDaysMultiplier,
    2: steady.medianDaysMultiplier,
  });
  console.log("PASS a multiplier that forecasts held-out sales better is applied, per product line when it beats the overall one");
}

{
  const report = market([
    { productLineId: 1, salesPerForecast: (listedDay) => (listedDay < 30 ? 0.5 : 1) },
  ]);
  assert.equal(report.overall.status, "not_better_held_out");
  assert.equal(report.overall.medianDaysMultiplier, undefined);
  assert.equal(report.productLines[0].status, "not_better_held_out");
  assert.equal(report.correction, null);
  console.log("PASS no correction applies when the earlier sales misforecast the held-out ones");
}

{
  const report = learnForecastCorrection({
    sellerKey: "seller",
    prices: [listed({ replacedAt: null })],
    sales: [],
    from: day(0),
    through: day(40),
    learnedAt: day(40),
    evidenceWindowDays: 40,
  });
  assert.equal(report.overall.status, "too_few_sales");
  assert.equal(report.correction, null);
  console.log("PASS too few sales leaves forecasts uncorrected");
}
