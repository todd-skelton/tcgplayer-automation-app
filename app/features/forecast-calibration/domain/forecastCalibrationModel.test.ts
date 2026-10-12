import assert from "node:assert/strict";
import {
  actualDaysHurdle,
  learnForecastCalibration,
  measureListedPrice,
  sellTimeMultiplier,
  type ListedPrice,
  type SkuSale,
} from "./forecastCalibrationModel";

const DAY_MS = 86_400_000;
const day = (value: number) => new Date(Date.UTC(2026, 8, 1) + value * DAY_MS);
/** A median of 2 ln 2 days forecasts half a sale per day in stock. */
const HALF_A_SALE_PER_DAY = 2 * Math.LN2;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const listed = (changes: Partial<ListedPrice> = {}): ListedPrice => ({
  sku: 1,
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
  close(sellTimeMultiplier({ listings: 1, inStockDays: 1, sales: 50, forecastSales: 100 }), 120 / 70);
  close(sellTimeMultiplier({ listings: 1, inStockDays: 1, sales: 0, forecastSales: 0 }), 1);
  close(sellTimeMultiplier({ listings: 1, inStockDays: 1, sales: 0, forecastSales: 500 }), 26);
  close(actualDaysHurdle(0.005, 1.25), 0.004);
  const forecastDays = 10;
  close(
    Math.exp(-0.005 * forecastDays),
    Math.exp(-actualDaysHurdle(0.005, 1.25) * forecastDays * 1.25),
  );
  console.log("PASS sell-time multipliers lean on pseudo-sales as forecast, and the hurdle converts to actual days");
}

/**
 * Each day the store lists eight one-day prices forecast at half a sale each,
 * and the share that sells follows the sales per forecast sale that day.
 */
function market(salesPerForecast: (listedDay: number) => number) {
  const prices: ListedPrice[] = [];
  const sales: SkuSale[] = [];
  for (let listedDay = 0; listedDay < 40; listedDay += 1) {
    const sellingCopies = Math.round(8 * 0.5 * salesPerForecast(listedDay));
    for (let copy = 0; copy < 8; copy += 1) {
      const sku = listedDay * 100 + copy;
      prices.push(listed({
        sku,
        countedAt: day(listedDay),
        listedAt: day(listedDay),
        replacedAt: day(listedDay + 1),
        quantity: 5,
      }));
      if (copy < sellingCopies) sales.push(sold(listedDay + 0.5, 1, sku));
    }
  }
  return learnForecastCalibration({
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
  const report = market(() => 0.5);
  assert.equal(report.heldOutFrom, day(30).toISOString());
  assert.equal(report.earlier.sales, 60);
  close(report.earlier.forecastSales, 120);
  assert.equal(report.heldOut.sales, 20);
  assert.equal(report.earlierMultiplier, Math.round((140 / 80) * 1000) / 1000);
  assert.equal(report.heldOutCheck, "confirmed");
  assert.equal(report.sellTimeMultiplier, Math.round((180 / 100) * 1000) / 1000);
  console.log("PASS listings that sell at half the forecast rate show close to twice the forecast days, confirmed on held-out sales");
}

{
  const report = market((listedDay) => (listedDay < 30 ? 0.5 : 1));
  assert.equal(report.heldOutCheck, "not_confirmed");
  console.log("PASS a multiplier the held-out sales contradict is not confirmed");
}

{
  const report = learnForecastCalibration({
    sellerKey: "seller",
    prices: [listed({ replacedAt: null })],
    sales: [],
    from: day(0),
    through: day(40),
    learnedAt: day(40),
    evidenceWindowDays: 40,
  });
  assert.equal(report.heldOutCheck, "too_few_sales");
  console.log("PASS too few sales leaves the calibration unconfirmed");
}
