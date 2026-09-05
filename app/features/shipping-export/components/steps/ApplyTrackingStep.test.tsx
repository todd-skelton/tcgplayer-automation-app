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
      isApplyingTracking={false}
      onApplyTracking={() => undefined}
      onBack={() => undefined}
      onContinue={() => undefined}
      {...overrides}
    />,
  );
}

const continueDisabled = /<button[^>]*\bdisabled\b[^>]*>Continue to Notify/;

const testCases: TestCase[] = [
  {
    name: "ApplyTrackingStep blocks continuing while updates are pending, even after earlier results",
    run: () => {
      const html = renderApplyTrackingStep({
        trackingApplyItems: [{ orderNumber: "B", carrier: "USPS", trackingNumber: "TRACK-B" }],
        alreadyTrackedCount: 1,
        trackingApplyResults: [appliedResult],
      });

      assert.match(html, /1 order ready to mark as shipped/);
      assert.match(html, /1 order already tracked in TCGPlayer will be skipped\./);
      assert.match(html, continueDisabled);
      assert.match(html, /Skip \(proceed anyway\)/);
    },
  },
  {
    name: "ApplyTrackingStep lets the operator continue once every order is tracked",
    run: () => {
      const html = renderApplyTrackingStep({ alreadyTrackedCount: 1, trackingApplyResults: [appliedResult] });

      assert.match(html, /Tracking is already applied to every order with production postage\./);
      assert.doesNotMatch(html, continueDisabled);
      assert.doesNotMatch(html, /Skip \(proceed anyway\)/);
    },
  },
  {
    name: "ApplyTrackingStep explains when no production postage exists",
    run: () => {
      const html = renderApplyTrackingStep();

      assert.match(html, /No orders have production postage ready for tracking/);
      assert.doesNotMatch(html, continueDisabled);
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
