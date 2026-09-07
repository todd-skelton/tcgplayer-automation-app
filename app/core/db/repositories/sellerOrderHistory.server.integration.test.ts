import assert from "node:assert/strict";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL is required before seller order history integration tests.");
const parsedTestUrl = new URL(testUrl);
const databaseName = parsedTestUrl.pathname.replace(/^\/+/, "");
if (!databaseName.startsWith("tcgplayer_fifo_test_")) {
  throw new Error("Seller order history integration tests require a tcgplayer_fifo_test_* database.");
}
if (process.env.DATABASE_URL !== testUrl) {
  throw new Error("DATABASE_URL must exactly match TEST_DATABASE_URL before seller order history integration tests.");
}

const { getPool } = await import("../database.server");
const { sellerOrderHistoryRepository } = await import("./sellerOrderHistory.server");
const { observeSellerOrder } = await import(
  "~/features/seller-order-history/domain/sellerOrderObservation"
);
const { synchronizeSellerOrders } = await import(
  "~/features/seller-order-history/services/synchronizeSellerOrders.server"
);
const { importSellerOrderCsv } = await import(
  "~/features/seller-order-history/services/sellerOrderFileImport.server"
);
const pool = getPool();
const seller = `integration-${Date.now()}`;

function detail(orderNumber: string, status = "Ready to Ship", quantity = 2) {
  return {
    createdAt: "2026-08-10T14:00:00.440Z", status,
    orderChannel: "TcgMarketplace", orderFulfillment: "Normal", orderNumber,
    sellerName: "", buyerName: "", paymentType: "", pickupStatus: "",
    shippingType: "Standard", estimatedDeliveryDate: "",
    transaction: { productAmount: quantity * 6.25, shippingAmount: 0,
      grossAmount: quantity * 6.25, feeAmount: 0, netAmount: quantity * 6.25,
      directFeeAmount: 0, taxes: [] },
    shippingAddress: { recipientName: "", addressOne: "", city: "", territory: "", country: "US", postalCode: "" },
    products: Array.from({ length: quantity }, () => ({ name: "Synthetic Card",
      unitPrice: 6.25, extendedPrice: 6.25, quantity: 1, url: "",
      productId: "10", skuId: "100" })),
    refunds: [], refundStatus: "No Refund", trackingNumbers: [], allowedActions: [],
  };
}

function summary(orderNumber: string, orderStatus = "Ready to Ship") {
  return {
    orderNumber, orderDate: "2026-08-10T14:00:00.000Z",
    orderChannel: "TcgMarketplace", orderStatus, buyerName: "",
    shippingType: "Standard", productAmount: 12.5, shippingAmount: 0,
    totalAmount: 12.5, buyerPaid: true, orderFulfillment: "Normal",
  };
}

try {
  const observed = observeSellerOrder(seller, summary("ORDER-1"), detail("ORDER-1"));
  const first = await sellerOrderHistoryRepository.recordObservation(observed);
  const replay = await sellerOrderHistoryRepository.recordObservation(observed);
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  const stored = await sellerOrderHistoryRepository.findOrder(seller, "ORDER-1");
  assert.deepEqual(stored?.lines, [{
    skuId: "100", productId: "10", orderedQuantity: 2, grossItemProceeds: 12.5,
  }]);

  const changed = observeSellerOrder(
    seller, summary("ORDER-1"), detail("ORDER-1", "Shipped - Delivered", 1),
    "2026-09-08T00:00:00Z",
  );
  assert.equal((await sellerOrderHistoryRepository.recordObservation(changed)).revision, 2);
  assert.equal((await sellerOrderHistoryRepository.recordObservation({
    ...observed, observedAt: "2026-09-09T00:00:00Z",
  })).revision, 3);

  await sellerOrderHistoryRepository.recordObservation(
    observeSellerOrder(`${seller}-other`, summary("ORDER-1"), detail("ORDER-1")),
  );
  assert.ok(await sellerOrderHistoryRepository.findOrder(`${seller}-other`, "ORDER-1"));

  const importResult = await importSellerOrderCsv({
    sellerKey: seller,
    csvText: `Order Number,Order Time,Status,SKU ID,Quantity,Gross Item Proceeds USD\nORDER-1,2025-01-01T00:00:00Z,Canceled,100,9,90.00`,
  });
  assert.equal(importResult.importedOrders, 0);
  assert.equal((await sellerOrderHistoryRepository.findOrder(seller, "ORDER-1"))?.sourceRevision, 3);

  const imported = (status: string, quantity: number) => importSellerOrderCsv({
    sellerKey: seller,
    csvText: `Order Number,Order Time,Status,SKU ID,Quantity,Gross Item Proceeds USD\nOLD-2,2025-01-01T00:00:00Z,${status},200,${quantity},${(quantity * 2).toFixed(2)}`,
  });
  const importA = await imported("Completed - Paid", 1);
  assert.equal(importA.importedOrders, 1);
  assert.equal((await imported("Canceled", 2)).importedOrders, 1);
  const repeatedA = await imported("Completed - Paid", 1);
  assert.equal(repeatedA.importedOrders, 0);
  assert.equal(repeatedA.duplicateFile, true);
  assert.equal((await sellerOrderHistoryRepository.findOrder(seller, "OLD-2"))?.sourceRevision, 2);
  assert.equal((await sellerOrderHistoryRepository.findOrder(seller, "OLD-2"))?.lines[0]?.orderedQuantity, 2);

  const syncSeller = `${seller}-sync`;
  let failB = true;
  const firstSync = await synchronizeSellerOrders(syncSeller, {
    maxPages: 1, maxDetails: 2, pageSize: 2, detailConcurrency: 2,
  }, {
    searchOrders: async () => ({ totalOrders: 2, orders: [summary("A"), summary("B")] }),
    getOrder: async (orderNumber) => {
      if (orderNumber === "B" && failB) throw new Error("temporary detail failure");
      return detail(orderNumber);
    },
  });
  assert.equal(firstSync.coverage.status, "incomplete");
  assert.deepEqual(firstSync.coverage.gaps, ["B"]);
  failB = false;
  const resumed = await synchronizeSellerOrders(syncSeller, {
    maxPages: 1, maxDetails: 2, pageSize: 2, detailConcurrency: 2,
  }, {
    searchOrders: async (request) => ({ totalOrders: 2, orders: request.from >= 2 ? [] : [summary("A"), summary("B")] }),
    getOrder: async (orderNumber) => detail(orderNumber),
  });
  assert.equal(resumed.coverage.status, "complete");
  assert.equal(resumed.coverage.detailsRecorded, 2);

  let unchangedDetailCalls = 0;
  const unchanged = await synchronizeSellerOrders(syncSeller, {}, {
    searchOrders: async () => ({ totalOrders: 2, orders: [summary("A"), summary("B")] }),
    getOrder: async (orderNumber) => { unchangedDetailCalls += 1; return detail(orderNumber); },
  });
  assert.equal(unchanged.coverage.status, "complete");
  assert.equal(unchangedDetailCalls, 0);
  assert.equal(unchanged.coverage.observedFrom, "2026-08-10T14:00:00.000Z");
  assert.equal(unchanged.coverage.observedThrough, "2026-08-10T14:00:00.000Z");

  const changedDetailNumbers: string[] = [];
  const changedScan = await synchronizeSellerOrders(syncSeller, {}, {
    searchOrders: async () => ({
      totalOrders: 2,
      orders: [summary("A"), summary("B", "Canceled")],
    }),
    getOrder: async (orderNumber) => {
      changedDetailNumbers.push(orderNumber);
      return detail(orderNumber, orderNumber === "B" ? "Canceled" : "Ready to Ship");
    },
  });
  assert.equal(changedScan.coverage.status, "complete");
  assert.deepEqual(changedDetailNumbers, ["B"]);
  assert.deepEqual(changedScan.changedOrderNumbers, ["B"]);
  const retainedCheckpoints = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM seller_order_sync_run_orders checkpoints
     JOIN seller_order_sync_runs run ON run.id = checkpoints.run_id
     WHERE run.seller_key = $1 AND run.status = 'complete'`,
    [syncSeller],
  );
  assert.equal(retainedCheckpoints.rows[0]?.count, 0);

  let unverifiedPriorityDetails = 0;
  const unverifiedSeller = `${seller}-unverified`;
  const unverifiedPriority = await synchronizeSellerOrders(
    unverifiedSeller,
    { maxPages: 1, maxDetails: 1, pageSize: 1, detailConcurrency: 1 },
    {
      searchOrders: async () => ({ totalOrders: 0, orders: [] }),
      getOrder: async (orderNumber) => {
        unverifiedPriorityDetails += 1;
        return detail(orderNumber);
      },
    },
    ["ORDER-1"],
  );
  assert.equal(unverifiedPriority.coverage.status, "complete");
  assert.equal(unverifiedPriorityDetails, 0);

  const claimSeller = `${seller}-claim`;
  const one = await sellerOrderHistoryRepository.startOrResumeApiRun(claimSeller, crypto.randomUUID());
  const two = await sellerOrderHistoryRepository.startOrResumeApiRun(claimSeller, crypto.randomUUID());
  assert.equal(one.acquired, true);
  assert.equal(two.acquired, false);

  const staleSeller = `${seller}-stale`;
  const staleToken = crypto.randomUUID();
  const staleRun = await sellerOrderHistoryRepository.startOrResumeApiRun(staleSeller, staleToken);
  await pool.query(
    `UPDATE seller_order_sync_runs SET claim_expires_at = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [staleRun.run.id],
  );
  await sellerOrderHistoryRepository.startOrResumeApiRun(staleSeller, crypto.randomUUID());
  await assert.rejects(
    () => sellerOrderHistoryRepository.recordApiObservation(
      staleRun.run.id,
      staleToken,
      observeSellerOrder(staleSeller, summary("STALE"), detail("STALE")),
    ),
    /lease was lost/,
  );
  assert.equal(await sellerOrderHistoryRepository.findOrder(staleSeller, "STALE"), null);

  console.log("PASS seller order history repository preserves revisions, account isolation, import precedence, gaps, and leases");
} finally {
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key LIKE $1`, [`${seller}%`]);
  await pool.query(`DELETE FROM seller_order_imports WHERE seller_key LIKE $1`, [`${seller}%`]);
  await pool.query(`DELETE FROM seller_orders WHERE seller_key LIKE $1`, [`${seller}%`]);
  await pool.end();
}
