import assert from "node:assert/strict";
import React, { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";
import { useShippingPullSheet } from "./useShippingPullSheet";

function order(orderNumber: string): TcgPlayerShippingOrder {
  return {
    "Order #": orderNumber, FirstName: "Test", LastName: "Buyer",
    Address1: "1 Main St", Address2: "", City: "Austin", State: "TX",
    PostalCode: "78701", Country: "US", "Order Date": "2026-09-12",
    "Product Weight": 0, "Shipping Method": "Standard", "Item Count": 1,
    "Value Of Products": 5, "Shipping Fee Paid": 0, "Tracking #": "", Carrier: "",
    products: [{ name: "Pikachu", quantity: 1, unitPrice: 5, skuId: 25 }],
  };
}

function csv(orderNumber: string) {
  return new Response([
    "Product Line,Product Name,Condition,SkuId,Quantity,Order Quantity",
    `Pokemon,Pikachu,Near Mint,25,1,${orderNumber}:1`,
    `Orders Contained in Pull Sheet:,${orderNumber}`,
  ].join("\n"));
}

let latest: ReturnType<typeof useShippingPullSheet>;
function Workflow({ orders }: { orders: TcgPlayerShippingOrder[] }) {
  const numbers = orders.map((item) => item["Order #"]);
  latest = useShippingPullSheet(numbers, orders, numbers, {});
  return <div>{latest.isGeneratingPullSheet ? "Loading" : latest.pullSheetItems.map((item) => item.productName).join(",")}</div>;
}

async function withWorkflow(run: (render: (orders: TcgPlayerShippingOrder[]) => Promise<void>, requests: Array<{ orderNumber: string; signal: AbortSignal; resolve: (response: Response) => void }>) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const originalActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const requests: Array<{ orderNumber: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
  let renderer: ReactTestRenderer | undefined;
  globalThis.fetch = async (url, init) => {
    if (url === "/api/pull-sheet-lookup") return Response.json({ skuMap: {} });
    assert.equal(url, "/api/shipping-export/pull-sheet-export");
    return new Promise<Response>((resolve) => {
      requests.push({ orderNumber: JSON.parse(String(init?.body)).orderNumbers[0], signal: init?.signal as AbortSignal, resolve });
    });
  };
  try {
    await run(async (orders) => {
      await act(async () => {
        if (renderer) renderer.update(<Workflow orders={orders} />);
        else renderer = create(<Workflow orders={orders} />);
      });
    }, requests);
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.fetch = originalFetch;
    environment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  }
}

const testCases = [
  {
    name: "focus and timer history refreshes preserve loaded cards without another export",
    run: () => withWorkflow(async (render, requests) => {
      await render([order("1001")]);
      assert.equal(latest.isGeneratingPullSheet, true);
      await act(async () => requests[0].resolve(csv("1001")));
      const loadedItems = latest.pullSheetItems;
      assert.equal(latest.packPullSheetStatus, "ready");
      assert.equal(latest.packPullSheetMatchesByReference["1001"].canRenderGrid, true);
      for (let refresh = 0; refresh < 3; refresh++) {
        await render([{ ...order("1001"), intakeHistory: {
          orderNumber: "1001", sellerKey: "test", lines: [], refreshedAt: String(refresh),
        } }]);
        assert.equal(latest.isGeneratingPullSheet, false);
        assert.equal(latest.pullSheetItems, loadedItems);
        assert.equal(latest.packPullSheetStatus, "ready");
        assert.equal(requests.length, 1);
      }
      // Local allocation still follows changed line items without a remote reload.
      await render([{ ...order("1001"), products: [{ name: "Pikachu", quantity: 2, unitPrice: 5, skuId: 25 }] }]);
      assert.equal(latest.packPullSheetMatchesByReference["1001"].expectedQuantity, 2);
      assert.equal(requests.length, 1);
    }),
  },
  {
    name: "replacing orders loads their rows and ignores a late response for the old orders",
    run: () => withWorkflow(async (render, requests) => {
      await render([order("1001")]);
      await render([order("1002")]);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].signal.aborted, true);
      await act(async () => requests[1].resolve(csv("1002")));
      await act(async () => requests[0].resolve(csv("1001")));
      assert.deepEqual(latest.pullSheetOrderIds, ["1002"]);
      assert.equal(latest.pullSheetItems[0].orderQuantity, "1002:1");
      assert.equal(latest.isGeneratingPullSheet, false);
    }),
  },
  {
    name: "reset clears rows and cancels a pending export",
    run: () => withWorkflow(async (render, requests) => {
      await render([order("1001")]);
      await render([]);
      await act(async () => requests[0].resolve(csv("1001")));
      assert.equal(requests[0].signal.aborted, true);
      assert.equal(latest.packPullSheetStatus, "idle");
      assert.equal(latest.isGeneratingPullSheet, false);
      assert.deepEqual(latest.pullSheetItems, []);
      assert.deepEqual(latest.packPullSheetMatchesByReference, {});
    }),
  },
  {
    name: "export errors remain visible without a history refresh retry loop",
    run: () => withWorkflow(async (render, requests) => {
      await render([order("1001")]);
      await act(async () => requests[0].resolve(Response.json({ error: "Export unavailable" }, { status: 503 })));
      await render([order("1001")]);
      assert.equal(latest.packPullSheetStatus, "error");
      assert.match(latest.pullSheetError!, /Export unavailable/);
      assert.equal(latest.isGeneratingPullSheet, false);
      assert.equal(requests.length, 1);
    }),
  },
];

for (const testCase of testCases) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${testCase.name}`, error);
  }
}
