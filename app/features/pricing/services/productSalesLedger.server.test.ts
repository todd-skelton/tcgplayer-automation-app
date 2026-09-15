import assert from "node:assert/strict";
import type { Sale } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import { fetchLatestSalesAndRecord } from "./productSalesLedger.server";

const sale: Sale = {
  condition: "Near Mint",
  variant: "Holofoil",
  language: "English",
  quantity: 1,
  title: "",
  listingType: "ListingWithoutPhotos",
  customListingId: "0",
  purchasePrice: 4.5,
  shippingPrice: 0,
  orderDate: "2026-09-05T11:27:48.177+00:00",
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

{
  const recorded: { productId: number; sales: Sale[] }[] = [];
  const result = await fetchLatestSalesAndRecord(
    { id: 676046 },
    { conditions: [] },
    100,
    {
      fetch: async () => [sale],
      record: async (productId, sales) => {
        recorded.push({ productId, sales });
      },
    },
  );
  await settle();
  assert.deepEqual(result, [sale]);
  assert.deepEqual(recorded, [{ productId: 676046, sales: [sale] }]);
  console.log("PASS fetched sales are returned unchanged and recorded for the product");
}

{
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const result = await fetchLatestSalesAndRecord(
      { id: 676046 },
      { conditions: [] },
      100,
      {
        fetch: async () => [sale],
        record: () => {
          throw new Error("database away");
        },
      },
    );
    await settle();
    assert.deepEqual(result, [sale]);
    // Other tests share this process, so look for this warning rather than counting.
    assert.ok(
      warnings.some(
        (args) =>
          String(args[0]).includes("Recording 1 sales for product 676046") &&
          args[1] instanceof Error,
      ),
    );
  } finally {
    console.warn = originalWarn;
  }
  console.log("PASS a failed recording only warns and still returns the sales");
}

{
  let recordCalls = 0;
  const result = await fetchLatestSalesAndRecord(
    { id: 676046 },
    { conditions: [] },
    100,
    {
      fetch: async () => [],
      record: async () => {
        recordCalls += 1;
      },
    },
  );
  await settle();
  assert.deepEqual(result, []);
  assert.equal(recordCalls, 0);
  console.log("PASS an empty response records nothing");
}
{
  const fiveSales = Array.from({ length: 5 }, (_, index) => ({
    ...sale,
    purchasePrice: 4 + index,
  }));
  const recorded: Sale[][] = [];
  let checks = 0;
  const result = await fetchLatestSalesAndRecord(
    { id: 676046 },
    { conditions: [] },
    100,
    {
      fetch: async () => fiveSales,
      record: async (_productId, sales) => {
        recorded.push(sales);
      },
      assertFullHistory: async () => {
        checks += 1;
      },
    },
  );
  await settle();
  assert.deepEqual(result, fiveSales);
  assert.equal(checks, 1);
  assert.deepEqual(recorded, [fiveSales]);
  console.log(
    "PASS a product with exactly five sales is checked once and then priced as usual",
  );
}

{
  const fiveSales = Array.from({ length: 5 }, () => sale);
  let recordCalls = 0;
  await assert.rejects(
    fetchLatestSalesAndRecord({ id: 676046 }, { conditions: [] }, 100, {
      fetch: async () => fiveSales,
      record: async () => {
        recordCalls += 1;
      },
      assertFullHistory: async () => {
        throw new Error("signed out");
      },
    }),
    { message: "signed out" },
  );
  await settle();
  assert.equal(recordCalls, 0);
  console.log("PASS five sales from a signed-out session fail the fetch before recording");
}

{
  let checks = 0;
  for (const count of [0, 1, 4, 6, 25]) {
    await fetchLatestSalesAndRecord({ id: 676046 }, { conditions: [] }, 100, {
      fetch: async () => Array.from({ length: count }, () => sale),
      record: async () => undefined,
      assertFullHistory: async () => {
        checks += 1;
      },
    });
  }
  await settle();
  assert.equal(checks, 0);
  console.log("PASS any other sale count is trusted without a check");
}
