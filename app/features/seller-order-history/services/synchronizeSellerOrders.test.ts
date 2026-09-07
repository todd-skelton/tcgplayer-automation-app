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
      return request.from === 0
        ? { totalOrders: 3, orders: [summary("A"), summary("B")] }
        : { totalOrders: 3, orders: [summary("C")] };
    },
    getOrder: async (number) => detail(number),
  });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.ordersObserved, 3);
  assert.deepEqual(new Set(result.changedOrderNumbers), new Set(["A", "B", "C"]));
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
