import assert from "node:assert/strict";
import {
  weeklySalesFromHistory,
  type WeeklySales,
} from "~/core/db/repositories/productWeeklySales.server";
import type { GetPriceHistoryResponse } from "~/integrations/tcgplayer/client/get-price-history.server";
import { fetchAnnualPriceHistoryAndRecord } from "./productWeeklySalesLedger.server";

const history: GetPriceHistoryResponse = {
  count: 1,
  result: [
    {
      skuId: "9001",
      variant: "Holofoil",
      language: "English",
      condition: "Near Mint",
      averageDailyQuantitySold: "1",
      averageDailyTransactionCount: "1",
      totalQuantitySold: "3",
      totalTransactionCount: "2",
      trendingMarketPricePercentages: {},
      buckets: [
        {
          marketPrice: "10.5",
          quantitySold: "3",
          lowSalePrice: "9.5",
          lowSalePriceWithShipping: "10.99",
          highSalePrice: "11",
          highSalePriceWithShipping: "12.49",
          transactionCount: "2",
          bucketStartDate: "2026-08-24T00:00:00.000Z",
        },
        {
          marketPrice: "10.5",
          quantitySold: "0",
          lowSalePrice: "0",
          lowSalePriceWithShipping: "0",
          highSalePrice: "0",
          highSalePriceWithShipping: "0",
          transactionCount: "0",
          bucketStartDate: "2026-08-31T00:00:00.000Z",
        },
      ],
    },
  ],
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

const weeks = weeklySalesFromHistory(676046, history);
assert.deepEqual(weeks, [
  {
    productId: 676046,
    skuId: 9001,
    condition: "Near Mint",
    variant: "Holofoil",
    language: "English",
    weekStart: "2026-08-24",
    transactions: 2,
    quantity: 3,
    lowSalePrice: 9.5,
    highSalePrice: 11,
    lowSalePriceWithShipping: 10.99,
    highSalePriceWithShipping: 12.49,
    tcgMarketPrice: 10.5,
  },
]);
console.log("PASS only traded weeks become ledger rows, with prices parsed and zero prices dropped");

{
  const recorded: WeeklySales[][] = [];
  const result = await fetchAnnualPriceHistoryAndRecord(676046, {
    fetch: async () => history,
    record: async (rows) => {
      recorded.push(rows);
    },
  });
  await settle();
  assert.equal(result, history);
  assert.deepEqual(recorded, [weeks]);
  console.log("PASS the fetched history is returned unchanged and its weeks recorded");
}

{
  let recordCalls = 0;
  const result = await fetchAnnualPriceHistoryAndRecord(676046, {
    fetch: async () => undefined,
    record: async () => {
      recordCalls += 1;
    },
  });
  await settle();
  assert.equal(result, undefined);
  assert.equal(recordCalls, 0);
  console.log("PASS a failed history fetch records nothing");
}

{
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const result = await fetchAnnualPriceHistoryAndRecord(676046, {
      fetch: async () => history,
      record: () => {
        throw new Error("database away");
      },
    });
    await settle();
    assert.equal(result, history);
    assert.ok(
      warnings.some((args) =>
        String(args[0]).includes("Recording weekly sales for product 676046"),
      ),
    );
  } finally {
    console.warn = originalWarn;
  }
  console.log("PASS a failed weekly recording only warns");
}
