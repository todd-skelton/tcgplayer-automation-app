import assert from "node:assert/strict";
import {
  buildShippingWorkflowOrderState,
  buildOrderNumbersInShipmentOrder,
  calculatePackageType,
  calculateService,
  createReturnShipment,
  getDeliveryConfirmation,
  mapOrderToShipment,
  buildTimestampedFileName,
  mergeOrdersByAddress,
  normalizeZipCode,
  sortShippingOrdersByOldestFirst,
} from "./shippingExportUtils";
import {
  DEFAULT_SHIPPING_EXPORT_CONFIG,
  mergeShippingExportConfigWithDefaults,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => void;
};

function createOrder(
  overrides: Partial<TcgPlayerShippingOrder> = {},
): TcgPlayerShippingOrder {
  return {
    "Order #": "1001",
    FirstName: "Jane",
    LastName: "Doe",
    Address1: "123 Main St",
    Address2: "",
    City: "Dallas",
    State: "TX",
    PostalCode: "75001",
    Country: "US",
    "Order Date": "2026-04-11",
    "Product Weight": 0,
    "Shipping Method": "Standard",
    "Item Count": 3,
    "Value Of Products": 10,
    "Shipping Fee Paid": 1.27,
    "Tracking #": "",
    Carrier: "",
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: "normalizeZipCode supports 5 digit and zip+4 output",
    run: () => {
      assert.equal(normalizeZipCode("123"), "00123");
      assert.equal(normalizeZipCode("12345"), "12345");
      assert.equal(normalizeZipCode("12345-6789"), "12345-6789");
      assert.equal(normalizeZipCode(987654321), "98765-4321");
    },
  },
  {
    name: "mergeOrdersByAddress combines same-address orders and preserves references",
    run: () => {
      const firstOrder = createOrder({ "Order #": "1001", "Item Count": 2 });
      const secondOrder = createOrder({
        "Order #": "1002",
        "Item Count": 4,
        "Value Of Products": 40,
      });

      const merged = mergeOrdersByAddress(
        [firstOrder, secondOrder],
        DEFAULT_SHIPPING_EXPORT_CONFIG.combineOrders,
      );

      assert.equal(merged.orders.length, 1);
      assert.equal(merged.orders[0]["Item Count"], 6);
      assert.equal(merged.orders[0]["Value Of Products"], 50);
      assert.deepEqual(merged.shipmentToOrderMap["1001"], ["1001", "1002"]);
    },
  },
  {
    name: "sortShippingOrdersByOldestFirst sorts by full order timestamp and keeps exact ties stable",
    run: () => {
      const firstSeenTie = createOrder({
        "Order #": "1003",
        "Order Date": "2026-04-11T10:30:00Z",
      });
      const olderOrder = createOrder({
        "Order #": "1001",
        "Order Date": "2026-04-11T08:15:00Z",
      });
      const secondSeenTie = createOrder({
        "Order #": "1002",
        "Order Date": "2026-04-11T10:30:00Z",
      });

      const ordered = sortShippingOrdersByOldestFirst([
        firstSeenTie,
        olderOrder,
        secondSeenTie,
      ]);

      assert.deepEqual(
        ordered.map((order) => order["Order #"]),
        ["1001", "1003", "1002"],
      );
    },
  },
  {
    name: "mergeOrdersByAddress preserves the provided grouped order sequence",
    run: () => {
      const newerOrder = createOrder({
        "Order #": "1002",
        "Order Date": "2026-04-11T11:00:00Z",
        "Item Count": 1,
        "Value Of Products": 10,
      });
      const olderOrder = createOrder({
        "Order #": "1001",
        "Order Date": "2026-04-11T09:00:00Z",
        "Item Count": 2,
        "Value Of Products": 25,
      });
      const unrelatedOrder = createOrder({
        "Order #": "1003",
        Address1: "999 Side St",
        "Order Date": "2026-04-11T12:00:00Z",
      });

      const merged = mergeOrdersByAddress(
        [newerOrder, unrelatedOrder, olderOrder],
        DEFAULT_SHIPPING_EXPORT_CONFIG.combineOrders,
      );

      assert.deepEqual(
        merged.orders.map((order) => order["Order #"]),
        ["1002", "1003"],
      );
      assert.deepEqual(merged.shipmentToOrderMap["1002"], ["1002", "1001"]);
    },
  },
  {
    name: "buildOrderNumbersInShipmentOrder keeps grouped shipments adjacent in shipment order",
    run: () => {
      const orderNumbers = buildOrderNumbersInShipmentOrder(
        ["1001", "1003", "1004"],
        {
          "1001": ["1001", "1002"],
          "1003": ["1003"],
          "1004": ["1004", "1005"],
        },
      );

      assert.deepEqual(orderNumbers, ["1001", "1002", "1003", "1004", "1005"]);
    },
  },
  {
    name: "buildShippingWorkflowOrderState centralizes canonical shipment and export order",
    run: () => {
      const workflowState = buildShippingWorkflowOrderState(
        [
          createOrder({
            "Order #": "1002",
            "Order Date": "2026-04-11T11:00:00Z",
          }),
          createOrder({
            "Order #": "1003",
            Address1: "999 Side St",
            "Order Date": "2026-04-11T12:00:00Z",
          }),
          createOrder({
            "Order #": "1001",
            "Order Date": "2026-04-11T09:00:00Z",
          }),
        ],
        DEFAULT_SHIPPING_EXPORT_CONFIG,
      );

      assert.deepEqual(
        workflowState.sourceOrders.map((order) => order["Order #"]),
        ["1001", "1002", "1003"],
      );
      assert.deepEqual(workflowState.shipmentReferences, ["1001", "1003"]);
      assert.deepEqual(workflowState.orderedOrderNumbers, ["1001", "1002", "1003"]);
      assert.deepEqual(
        workflowState.shipments.map((shipment) => shipment.reference),
        workflowState.shipmentReferences,
      );
    },
  },
  {
    name: "service and package thresholds route low-value standard orders to letter mail",
    run: () => {
      const order = createOrder();

      assert.equal(calculateService(order, DEFAULT_SHIPPING_EXPORT_CONFIG), "First");
      assert.equal(
        calculatePackageType(order, DEFAULT_SHIPPING_EXPORT_CONFIG),
        "Letter",
      );
    },
  },
  {
    name: "service and package thresholds escalate large or expedited orders",
    run: () => {
      const expeditedOrder = createOrder({
        "Shipping Method": "Expedited Mail",
      });
      const flatOrder = createOrder({
        "Item Count": (DEFAULT_SHIPPING_EXPORT_CONFIG.letter.maxItemCount ?? 0) + 1,
      });
      const parcelOrder = createOrder({
        "Value Of Products":
          (DEFAULT_SHIPPING_EXPORT_CONFIG.flat.maxValueUsd ?? 0) + 1,
      });

      assert.equal(
        calculatePackageType(expeditedOrder, DEFAULT_SHIPPING_EXPORT_CONFIG),
        "Parcel",
      );
      assert.equal(
        calculateService(expeditedOrder, DEFAULT_SHIPPING_EXPORT_CONFIG),
        DEFAULT_SHIPPING_EXPORT_CONFIG.expeditedService,
      );
      assert.equal(
        calculatePackageType(flatOrder, DEFAULT_SHIPPING_EXPORT_CONFIG),
        "Flat",
      );
      assert.equal(
        calculatePackageType(parcelOrder, DEFAULT_SHIPPING_EXPORT_CONFIG),
        "Parcel",
      );
      assert.equal(
        calculateService(parcelOrder, DEFAULT_SHIPPING_EXPORT_CONFIG),
        "GroundAdvantage",
      );
    },
  },
  {
    name: "delivery confirmation requires signature at 250 dollars and above",
    run: () => {
      assert.equal(getDeliveryConfirmation(249.99), "NO_SIGNATURE");
      assert.equal(getDeliveryConfirmation(250), "SIGNATURE");
    },
  },
  {
    name: "mapOrderToShipment applies address normalization and package defaults",
    run: () => {
      const shipment = mapOrderToShipment(
        createOrder({ PostalCode: 1234 }),
        DEFAULT_SHIPPING_EXPORT_CONFIG,
      );

      assert.equal(shipment.to_address.zip, "01234");
      assert.equal(shipment.from_address.country, "US");
      assert.equal(shipment.options.label_format, "PDF");
      assert.equal(shipment.parcel.predefined_package, "Letter");
    },
  },
  {
    name: "createReturnShipment swaps to and from addresses",
    run: () => {
      const shipment = mapOrderToShipment(createOrder(), DEFAULT_SHIPPING_EXPORT_CONFIG);
      const returnShipment = createReturnShipment(shipment);

      assert.equal(returnShipment.to_address.name, shipment.from_address.name);
      assert.equal(returnShipment.from_address.name, shipment.to_address.name);
    },
  },
  {
    name: "mergeShippingExportConfigWithDefaults preserves defaults for missing values",
    run: () => {
      const mergedConfig = mergeShippingExportConfigWithDefaults({
        fromAddress: {
          name: "Warehouse",
          city: "Austin",
        },
        labelFormat: "PNG",
        flat: {
          maxValueUsd: 125,
        },
      });

      assert.equal(mergedConfig.fromAddress.name, "Warehouse");
      assert.equal(mergedConfig.fromAddress.country, "US");
      assert.equal(mergedConfig.labelFormat, "PNG");
      assert.equal(mergedConfig.flat.maxValueUsd, 125);
      assert.equal(
        mergedConfig.easypostMode,
        DEFAULT_SHIPPING_EXPORT_CONFIG.easypostMode,
      );
      assert.equal(
        mergedConfig.letter.labelSize,
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.labelSize,
      );
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    testCase.run();
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
  console.log(`Passed ${testCases.length} shipping export tests.`);
}


