import assert from "node:assert/strict";
import { synchronizeSellerOrders } from "./synchronizeSellerOrders.server";
import type { SellerOrderDetail } from "~/integrations/tcgplayer/client/get-seller-order.server";

function detail(orderNumber: string): SellerOrderDetail {
  return {
    createdAt: "2026-08-10T14:00:00.440Z", status: "Completed - Paid",
    orderChannel: "TcgMarketplace", orderFulfillment: "Normal", orderNumber,
    sellerName: "", buyerName: "", paymentType: "", pickupStatus: "",
    shippingType: "Standard", estimatedDeliveryDate: "",
    transaction: { productAmount: 1, shippingAmount: 0, grossAmount: 1,
      feeAmount: 0, netAmount: 1, directFeeAmount: 0, taxes: [] },
    shippingAddress: { recipientName: "", addressOne: "", city: "", territory: "", country: "US", postalCode: "" },
    products: [{ name: "Card", unitPrice: 1, extendedPrice: 1, quantity: 1,
      url: "", productId: "10", skuId: "100" }],
    refunds: [], refundStatus: "No Refund", trackingNumbers: [], allowedActions: [],
  };
}

{
  const fake = fakeRepository();
  (fake.repository as any).findApiVerifiedOrderNumbers = async () => [];
  const searches: Array<string | undefined> = [];
  let detailCalls = 0;
  await synchronizeSellerOrders("seller-a", {
    maxPages: 1, maxDetails: 1, pageSize: 1, detailConcurrency: 1,
  }, {
    repository: fake.repository,
    searchOrders: async (request) => {
      searches.push(request.query?.orderNumber);
      return request.query?.orderNumber === "NEW"
        ? { totalOrders: 1, orders: [summary("NEW")] }
        : { totalOrders: 0, orders: [] };
    },
    getOrder: async (number) => { detailCalls += 1; return detail(number); },
  }, ["NEW"]);
  assert.deepEqual(searches, ["NEW"]);
  assert.equal(detailCalls, 1);
}

function summary(orderNumber: string) {
  return {
    orderNumber, orderDate: "2026-08-10T14:00:00.000Z",
    orderChannel: "TcgMarketplace", orderStatus: "Completed - Paid", buyerName: "",
    shippingType: "Standard", productAmount: 1, shippingAmount: 0,
    totalAmount: 1, buyerPaid: true, orderFulfillment: "Normal",
  };
}

function fakeRepository(initial: {
  nextOffset?: number; expectedTotal?: number; gaps?: string[];
  seen?: string[]; acquired?: boolean; needed?: string[];
} = {}) {
  const seen = new Set(initial.seen ?? []);
  const state: any = {
    id: "1", sellerKey: "seller-a", source: "tcgplayer_api", status: "incomplete",
    searchRange: "LastThreeMonths", startedAt: new Date("2026-09-07T00:00:00Z"),
    finishedAt: null, nextOffset: initial.nextOffset ?? 0,
    expectedTotal: initial.expectedTotal ?? null, pagesCompleted: 0,
    ordersObserved: seen.size, detailsRecorded: 0, observedFrom: null,
    observedThrough: null, gaps: initial.gaps ?? [], error: null,
    claimToken: null, claimExpiresAt: null,
  };
  const coverage = () => ({
    sellerKey: state.sellerKey, source: state.source, status: state.status,
    searchRange: state.searchRange, ordersObserved: state.ordersObserved,
    detailsRecorded: state.detailsRecorded, nextOffset: state.nextOffset,
    ...(state.expectedTotal === null ? {} : { expectedTotal: state.expectedTotal }),
    gaps: state.gaps, ...(state.error ? { error: state.error } : {}),
  });
  return {
    state,
    repository: {
      startOrResumeApiRun: async (_seller: string, token: string) => {
        state.status = "running"; state.claimToken = token;
        return { run: { ...state }, acquired: initial.acquired !== false };
      },
      getCoverage: async () => coverage(),
      recordObservation: async () => ({ changed: true, orderId: "1", revision: 1 }),
      recordApiObservation: async () => ({ changed: true, orderId: "1", revision: 1 }),
      findDetailsNeeded: async (_seller: string, summaries: Array<{ orderNumber: string }>) =>
        initial.needed ?? summaries.map((value) => value.orderNumber),
      findApiVerifiedOrderNumbers: async (_seller: string, orderNumbers: string[]) => orderNumbers,
      saveApiProgress: async (input: any) => {
        input.orderNumbers?.forEach((value: string) => seen.add(value));
        state.nextOffset = input.nextOffset; state.expectedTotal = input.expectedTotal;
        state.ordersObserved = seen.size; state.detailsRecorded += input.detailCount;
        state.gaps = input.gaps;
        return coverage();
      },
      finishApiRun: async (_id: string, _token: string, complete: boolean, error?: string) => {
        state.status = complete ? "complete" : "incomplete"; state.error = error ?? null;
        return coverage();
      },
      restartInconsistentApiRun: async (_id: string, _token: string, error: string) => {
        seen.clear(); state.nextOffset = 0; state.expectedTotal = null;
        state.ordersObserved = 0; state.status = "incomplete"; state.error = error;
        return coverage();
      },
    } as never,
  };
}

{
  const orders = Array.from({ length: 500 }, (_, index) => summary(`FRESH-${index}`));
  const fake = fakeRepository({ needed: [] });
  let detailCalls = 0;
  const result = await synchronizeSellerOrders("seller-a", {}, {
    repository: fake.repository,
    searchOrders: async () => ({ totalOrders: 500, orders }),
    getOrder: async (number) => { detailCalls += 1; return detail(number); },
  });
  assert.equal(detailCalls, 0);
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.ordersObserved, 500);
}

{
  const fake = fakeRepository();
  const offsets: number[] = [];
  const result = await synchronizeSellerOrders("seller-a", {
    maxPages: 2, maxDetails: 4, pageSize: 2, detailConcurrency: 2,
  }, {
    repository: fake.repository,
    searchOrders: async (request) => {
      offsets.push(request.from);
      const orders = [summary("A"), summary("B"), summary("C")];
      return { totalOrders: orders.length, orders: orders.slice(request.from, request.from + request.size) };
    },
    getOrder: async (number) => detail(number),
  });
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.ordersObserved, 3);
  assert.deepEqual(new Set(result.changedOrderNumbers), new Set(["A", "B", "C"]));
}

{
  const fake = fakeRepository();
  const offsets: number[] = [];
  const orders = [summary("ONE-A"), summary("ONE-B"), summary("ONE-C")];
  const result = await synchronizeSellerOrders("seller-a", {
    maxPages: 4, maxDetails: 4, pageSize: 1, detailConcurrency: 1,
  }, {
    repository: fake.repository,
    searchOrders: async (request) => {
      offsets.push(request.from);
      return { totalOrders: orders.length, orders: orders.slice(request.from, request.from + 1) };
    },
    getOrder: async (number) => detail(number),
  });
  assert.deepEqual(offsets, [0, 1, 2]);
  assert.equal(result.coverage.status, "complete");
}

{
  const fake = fakeRepository({ nextOffset: 2, expectedTotal: 4, seen: ["A", "B"] });
  const result = await synchronizeSellerOrders("seller-a", {}, {
    repository: fake.repository,
    searchOrders: async () => ({ totalOrders: 4, orders: [summary("A"), summary("B")] }),
    getOrder: async (number) => detail(number),
  });
  assert.equal(result.coverage.status, "incomplete");
  assert.match(result.coverage.error ?? "", /repeated a page/);
  assert.equal(result.coverage.nextOffset, 0);
}

{
  const fake = fakeRepository();
  let orders = [summary("A"), summary("B"), summary("C"), summary("D")];
  const scan = () => synchronizeSellerOrders("seller-a", {
    maxPages: 1, maxDetails: 2, pageSize: 2, detailConcurrency: 2,
  }, {
    repository: fake.repository,
    searchOrders: async (request) => ({
      totalOrders: orders.length,
      orders: orders.slice(request.from, request.from + request.size),
    }),
    getOrder: async (number) => detail(number),
  });
  assert.equal((await scan()).coverage.nextOffset, 2);
  orders = [summary("B"), summary("C"), summary("D"), summary("E")];
  const overlap = await scan();
  assert.equal(overlap.coverage.nextOffset, 3);
  assert.ok(overlap.changedOrderNumbers.includes("C"));
  const completed = await scan();
  assert.equal(completed.coverage.status, "complete");
  assert.equal(fake.state.ordersObserved, 5);
}

{
  const fake = fakeRepository({ nextOffset: 1, expectedTotal: 2 });
  const result = await synchronizeSellerOrders("seller-a", {}, {
    repository: fake.repository,
    searchOrders: async () => ({ totalOrders: 2, orders: [] }),
    getOrder: async (number) => detail(number),
  });
  assert.equal(result.coverage.status, "incomplete");
  assert.match(result.coverage.error ?? "", /empty page/);
}

{
  const fake = fakeRepository();
  const privateSummary = { ...summary("PRIVATE-GAP"), buyerName: "DO-NOT-PERSIST" };
  await synchronizeSellerOrders("seller-a", {}, {
    repository: fake.repository,
    searchOrders: async () => ({ totalOrders: 1, orders: [privateSummary] }),
    getOrder: async () => { throw new Error("safe failure"); },
  });
  assert.equal(JSON.stringify(fake.state.gaps).includes("DO-NOT-PERSIST"), false);
}

{
  const fake = fakeRepository({ acquired: false });
  let searched = false;
  const result = await synchronizeSellerOrders("seller-a", {}, {
    repository: fake.repository,
    searchOrders: async () => { searched = true; return { totalOrders: 0, orders: [] }; },
    getOrder: async (number) => detail(number),
  });
  assert.equal(searched, false);
  assert.equal(result.coverage.status, "running");
}

console.log("PASS seller order sync is bounded, resumable, fenced, and detects incomplete pagination");
