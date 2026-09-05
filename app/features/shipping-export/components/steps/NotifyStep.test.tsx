import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShippingShippedMessageResult } from "../../types/shippingExport";
import { NotifyStep } from "./NotifyStep";

type TestCase = {
  name: string;
  run: () => void;
};

const sentResult: ShippingShippedMessageResult = {
  orderNumber: "A",
  sellerKey: "seller",
  easypostShipmentId: "shp_A",
  status: "sent",
};

function renderNotifyStep(
  overrides: Partial<React.ComponentProps<typeof NotifyStep>> = {},
): string {
  return renderToStaticMarkup(
    <NotifyStep
      shippedMessageItems={[]}
      alreadySentCount={0}
      shippedMessageResults={[]}
      isSendingShippedMessages={false}
      onSendShippedMessages={() => undefined}
      onBack={() => undefined}
      onReset={() => undefined}
      {...overrides}
    />,
  );
}

const testCases: TestCase[] = [
  {
    name: "NotifyStep withholds batch completion while messages are still pending",
    run: () => {
      const html = renderNotifyStep({
        shippedMessageItems: [{ orderNumber: "B", sellerKey: "seller", easypostShipmentId: "shp_B" }],
        alreadySentCount: 1,
        shippedMessageResults: [sentResult],
      });

      assert.match(html, /1 order ready to receive shipped messages/);
      assert.match(html, /1 order already messaged will be skipped\./);
      assert.doesNotMatch(html, /Batch complete/);
    },
  },
  {
    name: "NotifyStep reports batch completion once every order is messaged",
    run: () => {
      const html = renderNotifyStep({ alreadySentCount: 1, shippedMessageResults: [sentResult] });

      assert.match(html, /Every order with production postage has already received its shipped message\./);
      assert.match(html, /Batch complete/);
      assert.match(html, /<button[^>]*\bdisabled\b[^>]*>Send Shipped Messages/);
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
  console.log(`Passed ${testCases.length} NotifyStep render tests.`);
}
