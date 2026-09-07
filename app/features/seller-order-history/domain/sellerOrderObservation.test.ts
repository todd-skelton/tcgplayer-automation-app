import assert from "node:assert/strict";
import {
  aggregateSellerOrderLines,
  normalizeSellerOrderLifecycle,
  observeSellerOrder,
} from "./sellerOrderObservation";
import type { SellerOrderDetail } from "~/integrations/tcgplayer/client/get-seller-order.server";

const baseDetail: SellerOrderDetail = {
  createdAt: "2026-08-10T14:00:00.440Z",
  status: "Ready to Ship",
  orderChannel: "TcgMarketplace",
  orderFulfillment: "Normal",
  orderNumber: "SYNTHETIC-1001",
  sellerName: "",
  buyerName: "",
  paymentType: "",
  pickupStatus: "",
  shippingType: "Standard",
  estimatedDeliveryDate: "",
  transaction: {
    productAmount: 12.5, shippingAmount: 0, grossAmount: 12.5,
    feeAmount: 0, netAmount: 12.5, directFeeAmount: 0, taxes: [],
  },
  shippingAddress: {
    recipientName: "", addressOne: "", city: "", territory: "",
    country: "US", postalCode: "",
  },
  products: [
    { name: "Card", unitPrice: 6.25, extendedPrice: 6.25, quantity: 1, url: "", productId: "10", skuId: "100" },
    { name: "Card", unitPrice: 6.25, extendedPrice: 6.25, quantity: 1, url: "", productId: "10", skuId: "100" },
  ],
  refunds: [{
    createdAt: "2026-08-11T00:00:00Z", type: "Partial", amount: 1.25,
    origin: "BuyerInitiated", reason: "ProviderEnum", reasonText: "private note",
    products: [{ amount: 1.25, productId: "10", skuId: "100", private: "drop" }],
  }],
  refundStatus: "Partial Refund",
  trackingNumbers: [],
  allowedActions: [],
};

assert.equal(normalizeSellerOrderLifecycle(" Shipped - Delivered "), "shipped_delivered");
assert.equal(normalizeSellerOrderLifecycle("provider future status"), "unknown");

const aggregate = aggregateSellerOrderLines(baseDetail.products);
assert.deepEqual(aggregate.map((line) => ({ sku: line.skuId, quantity: line.quantity, proceeds: line.extendedPrice })), [
  { sku: "100", quantity: 2, proceeds: 12.5 },
]);

const first = observeSellerOrder(" seller-a ", {
  orderNumber: "SYNTHETIC-1001", orderDate: "2026-08-10T14:00:00.000Z",
  orderChannel: "TcgMarketplace", orderStatus: "Ready to Ship", buyerName: "private",
  shippingType: "Standard", productAmount: 12.5, shippingAmount: 0,
  totalAmount: 12.5, buyerPaid: true, orderFulfillment: "Normal",
}, baseDetail, "2026-09-07T00:00:00Z");
const reordered = observeSellerOrder("seller-a", undefined, {
  ...baseDetail,
  products: [...baseDetail.products].reverse(),
}, "2026-09-08T00:00:00Z");

assert.equal(first.sellerKey, "seller-a");
assert.equal(first.orderTime, baseDetail.createdAt);
assert.equal(first.summaryOrderTime, "2026-08-10T14:00:00.000Z");
assert.equal(first.fingerprint, reordered.fingerprint);
assert.equal("reasonText" in first.refunds[0]!, false);
assert.deepEqual(first.refunds[0]?.products, [{ amount: 1.25, productId: "10", skuId: "100" }]);
assert.equal(
  observeSellerOrder("seller-a", undefined, {
    ...baseDetail,
    createdAt: "2026-08-10T10:00:00.440-04:00",
  }).orderTime,
  baseDetail.createdAt,
);
assert.throws(
  () => observeSellerOrder("seller-a", undefined, { ...baseDetail, createdAt: "2026-08-10T14:00:00" }),
  /UTC offset/,
);
assert.throws(
  () => observeSellerOrder("seller-a", undefined, {
    ...baseDetail,
    products: [{ ...baseDetail.products[0]!, extendedPrice: -1 }],
  }),
  /invalid price/,
);
console.log("PASS seller order observations normalize lifecycle, stable SKU lines, time, and evidence");
