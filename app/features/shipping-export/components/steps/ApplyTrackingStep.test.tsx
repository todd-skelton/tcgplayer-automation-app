import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShippingTrackingApplyResult } from "../../types/shippingExport";
import { ApplyTrackingStep } from "./ApplyTrackingStep";

type TestCase = {
  name: string;
  run: () => void;
};

const appliedResult: ShippingTrackingApplyResult = {
  orderNumber: "A",
  carrier: "USPS",
  trackingNumber: "TRACK-A",
  status: "applied",
};

function renderApplyTrackingStep(
  overrides: Partial<React.ComponentProps<typeof ApplyTrackingStep>> = {},
): string {
  return renderToStaticMarkup(
    <ApplyTrackingStep
      trackingApplyItems={[]}
      alreadyTrackedCount={0}
      trackingApplyResults={[]}
      {...overrides}
    />,
  );
}

const testCases: TestCase[] = [
  {
    name: "ApplyTrackingStep lists pending updates alongside earlier results",
    run: () => {
      const html = renderApplyTrackingStep({
        trackingApplyItems: [{ orderNumber: "B", carrier: "USPS", trackingNumber: "TRACK-B" }],
        alreadyTrackedCount: 1,
        trackingApplyResults: [appliedResult],
      });

      assert.match(html, /1 order ready to mark as shipped/);
      assert.match(html, /1 order already tracked in TCGPlayer will be skipped\./);
      assert.match(html, /Applied tracking to 1 order\./);
    },
  },
  {
    name: "ApplyTrackingStep reports when every order is tracked",
    run: () => {
      const html = renderApplyTrackingStep({ alreadyTrackedCount: 1, trackingApplyResults: [appliedResult] });

      assert.match(html, /Tracking is already applied to every order with production postage\./);
    },
  },
  {
    name: "ApplyTrackingStep explains when no production postage exists",
    run: () => {
      const html = renderApplyTrackingStep();

      assert.match(html, /No orders have production postage ready for tracking/);
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
  console.log(`Passed ${testCases.length} ApplyTrackingStep render tests.`);
}
