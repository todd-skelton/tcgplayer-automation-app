import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShippingStepBar } from "./ShippingStepBar";

const render = (overrides: Partial<React.ComponentProps<typeof ShippingStepBar>> = {}) =>
  renderToStaticMarkup(
    <ShippingStepBar
      progress={{ summary: "0 of 2 shipments packed", readyToContinue: false, canSkip: true }}
      nextStepLabel="Apply Tracking"
      onBack={() => {}}
      onNext={() => {}}
      onStartNewBatch={() => {}}
      {...overrides}
    />,
  );

const disabledButton = (label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}`);

const blocked = render();
assert.match(blocked, /0 of 2 shipments packed/);
assert.match(blocked, />Back</);
assert.match(blocked, disabledButton("Continue to Apply Tracking"));
assert.match(blocked, /aria-label="More ways to continue"/, "a step that can be skipped offers it behind the menu");
assert.doesNotMatch(blocked, /Skip to Apply Tracking/, "the skip choice stays in the menu until asked for");

const ready = render({ progress: { summary: "2 of 2 shipments packed", readyToContinue: true, canSkip: true } });
assert.doesNotMatch(ready, disabledButton("Continue to Apply Tracking"));
assert.doesNotMatch(ready, /More ways to continue/);

const firstStep = render({
  progress: { summary: "No orders loaded", readyToContinue: false, canSkip: false },
  nextStepLabel: "Pull Sheet",
  onBack: undefined,
});
assert.doesNotMatch(firstStep, />Back</);
assert.match(firstStep, disabledButton("Continue to Pull Sheet"));
assert.doesNotMatch(firstStep, /More ways to continue/);

const withAction = render({
  action: { label: "Applying Tracking...", busy: true, disabled: true, onClick: () => {} },
});
assert.match(withAction, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Applying Tracking\.\.\./);
assert.match(withAction, /MuiCircularProgress/);

const lastStep = render({
  progress: { summary: "Every order with production postage has its shipped message", readyToContinue: true, canSkip: false },
  nextStepLabel: null,
  action: { label: "Send Shipped Messages", busy: false, disabled: true, onClick: () => {} },
});
assert.match(lastStep, /Start New Batch/);
assert.match(lastStep, disabledButton("Send Shipped Messages"));
assert.doesNotMatch(lastStep, /Continue to/);

console.log("PASS shipping step bar shows step progress, its action, and how to move on");
