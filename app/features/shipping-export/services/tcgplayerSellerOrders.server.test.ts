import assert from "node:assert/strict";
import type { SellerOrderDetail } from "~/integrations/tcgplayer/client/get-seller-order.server";
import {
  loadSellerShippingOrders,
  mapSellerOrderDetailToShippingOrder,
} from "./tcgplayerSellerOrders.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function createSellerOrderDetail(
  overrides: Partial<SellerOrderDetail> = {},
): SellerOrderDetail {
  return {
    createdAt: "2026-04-12T17:44:01.18Z",
    status: "Ready to Ship",
    orderChannel: "TcgMarketplace",
    orderFulfillment: "Normal",
    orderNumber: "8520A14F-30F86B-3D074",
    sellerName: "PokeBash TCG",
    buyerName: "Connor McLauchlin",
    paymentType: "PAYPAL",
    pickupStatus: "",
    shippingType: "Standard (7-10 days)",
    estimatedDeliveryDate: "2026-04-24T17:44:01.107Z",
    transaction: {
      productAmount: 10.01,
      shippingAmount: 0,
      grossAmount: 10.01,
      feeAmount: 1.65,
      netAmount: 8.36,
      directFeeAmount: 0,
      taxes: [{ code: "Total", amount: 0.95 }],
    },
    shippingAddress: {
      recipientName: "Connor McLauchlin",
      addressOne: "9010 218TH STREET CT E",
      city: "GRAHAM",
      territory: "WA",
      country: "US",
      postalCode: "98338-9256",
    },
    products: [
      {
        name: "Magearna EX",
        unitPrice: 10.01,
        extendedPrice: 10.01,
        quantity: 1,
        url: "https://example.com/1",
        productId: "121234",
        skuId: "3191391",
      },
    ],
    refunds: [],
    refundStatus: "",
    trackingNumbers: [],
    allowedActions: ["PartialRefund"],
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: "mapSellerOrderDetailToShippingOrder maps standard detail fields",
    run: () => {
      const order = mapSellerOrderDetailToShippingOrder(createSellerOrderDetail());

      assert.deepEqual(order, {
        "Order #": "8520A14F-30F86B-3D074",
        FirstName: "Connor",
        LastName: "McLauchlin",
        Address1: "9010 218TH STREET CT E",
        Address2: "",
        City: "GRAHAM",
        State: "WA",
        PostalCode: "98338-9256",
        Country: "US",
        "Order Date": "2026-04-12T17:44:01.18Z",
        "Product Weight": 0,
        "Shipping Method": "Standard (7-10 days)",
        "Item Count": 1,
        "Value Of Products": 10.01,
        "Shipping Fee Paid": 0,
        "Tracking #": "",
        Carrier: "",
      });
    },
  },
  {
    name: "mapSellerOrderDetailToShippingOrder sums quantities and handles single-token names",
    run: () => {
      const order = mapSellerOrderDetailToShippingOrder(
        createSellerOrderDetail({
          shippingAddress: {
            recipientName: "Madonna",
            addressOne: "123 Main St",
            addressTwo: "Unit 4",
            city: "Austin",
            territory: "TX",
            country: "US",
            postalCode: "78701",
          },
          products: [
            {
              name: "Card A",
              unitPrice: 2,
              extendedPrice: 4,
              quantity: 2,
              url: "https://example.com/a",
              productId: "1",
              skuId: "1",
            },
            {
              name: "Card B",
              unitPrice: 3,
              extendedPrice: 9,
              quantity: 3,
              url: "https://example.com/b",
              productId: "2",
              skuId: "2",
            },
          ],
          transaction: {
            productAmount: 13,
            shippingAmount: 1.31,
            grossAmount: 14.31,
            feeAmount: 0,
            netAmount: 0,
            directFeeAmount: 0,
            taxes: [],
          },
          shippingType: "Expedited (3-5 days)",
        }),
      );

      assert.equal(order.FirstName, "Madonna");
      assert.equal(order.LastName, "");
      assert.equal(order.Address2, "Unit 4");
      assert.equal(order["Item Count"], 5);
      assert.equal(order["Shipping Fee Paid"], 1.31);
      assert.equal(order["Shipping Method"], "Expedited (3-5 days)");
    },
  },
  {
    name: "mapSellerOrderDetailToShippingOrder tolerates empty recipient names",
    run: () => {
      const order = mapSellerOrderDetailToShippingOrder(
        createSellerOrderDetail({
          shippingAddress: {
            recipientName: "   ",
            addressOne: "456 Oak Ave",
            city: "Seattle",
            territory: "WA",
            country: "US",
            postalCode: "98101",
          },
        }),
      );

      assert.equal(order.FirstName, "");
      assert.equal(order.LastName, "");
    },
  },
  {
    name: "loadSellerShippingOrders paginates search results and keeps partial failures as warnings",
    run: async () => {
      const capturedOffsets: number[] = [];
      const response = await loadSellerShippingOrders("seller-123", {
        searchOrders: async (request) => {
          capturedOffsets.push(request.from);

          if (request.from === 0) {
            return {
              totalOrders: 3,
              orders: [
                {
                  orderNumber: "A",
                  orderDate: "2026-04-12T00:00:00Z",
                  orderChannel: "TcgMarketplace",
                  orderStatus: "Ready to Ship",
                  buyerName: "Buyer A",
                  shippingType: "Standard",
                  productAmount: 1,
                  shippingAmount: 0,
                  totalAmount: 1,
                  buyerPaid: true,
                  orderFulfillment: "Normal",
                },
                {
                  orderNumber: "B",
                  orderDate: "2026-04-12T00:00:00Z",
                  orderChannel: "TcgMarketplace",
                  orderStatus: "Ready to Ship",
                  buyerName: "Buyer B",
                  shippingType: "Standard",
                  productAmount: 1,
                  shippingAmount: 0,
                  totalAmount: 1,
                  buyerPaid: true,
                  orderFulfillment: "Normal",
                },
              ],
            };
          }

          return {
            totalOrders: 3,
            orders: [
              {
                orderNumber: "C",
                orderDate: "2026-04-12T00:00:00Z",
                orderChannel: "TcgMarketplace",
                orderStatus: "Ready to Ship",
                buyerName: "Buyer C",
                shippingType: "Standard",
                productAmount: 1,
                shippingAmount: 0,
                totalAmount: 1,
                buyerPaid: true,
                orderFulfillment: "Normal",
              },
            ],
          };
        },
        getOrder: async (orderNumber) => {
          if (orderNumber === "B") {
            throw new Error("403");
          }

          return createSellerOrderDetail({
            orderNumber,
            shippingAddress: {
              recipientName: `Buyer ${orderNumber}`,
              addressOne: `${orderNumber} Main St`,
              city: "Austin",
              territory: "TX",
              country: "US",
              postalCode: "78701",
            },
          });
        },
      });

      assert.deepEqual(capturedOffsets, [0, 500]);
      assert.equal(response.sellerKey, "seller-123");
      assert.equal(response.totalOrders, 3);
      assert.deepEqual(response.loadedOrderNumbers, ["A", "C"]);
      assert.equal(response.orders.length, 2);
      assert.equal(response.warnings?.length, 1);
      assert.match(response.warnings?.[0] ?? "", /Failed to load seller order B/);
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Passed ${testCases.length} TCGPlayer seller order tests.`);
}
