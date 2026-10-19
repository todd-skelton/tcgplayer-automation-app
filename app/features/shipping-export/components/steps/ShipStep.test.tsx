import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ShipStep } from "./ShipStep";

const visibleText = (html: string) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const render = (props: Partial<React.ComponentProps<typeof ShipStep>> = {}) =>
  visibleText(
    renderToStaticMarkup(
      <ShipStep pendingOrderNumbers={[]} shippedOrderCount={0} trackingApplyResults={[]} shippedMessageResults={[]} {...props} />,
    ),
  );

const pending = render({
  pendingOrderNumbers: ["B"],
  shippedOrderCount: 1,
  trackingApplyResults: [{ orderNumber: "A", carrier: "USPS", trackingNumber: "TRACK-A", status: "applied" }],
  shippedMessageResults: [{ orderNumber: "A", sellerKey: "s", easypostShipmentId: "shp_A", status: "sent" }],
});
assert.match(pending, /1 order ready to mark as shipped in TCGPlayer and notify the buyer\./);
assert.match(pending, /A applied TRACK-A sent/, "tracking and message outcomes share one row per order");
assert.doesNotMatch(pending, /Batch complete/);

const failed = render({
  pendingOrderNumbers: ["A"],
  trackingApplyResults: [{ orderNumber: "A", carrier: "USPS", trackingNumber: "TRACK-A", status: "failed", error: "Order locked" }],
});
assert.match(failed, /1 order could not be completed/);
assert.match(failed, /A failed TRACK-A - Order locked/, "an order whose tracking failed shows no message outcome");

const complete = render({
  shippedOrderCount: 2,
  shippedMessageResults: [{ orderNumber: "A", sellerKey: "s", easypostShipmentId: "shp_A", status: "sent" }],
});
assert.match(complete, /Every order with production postage is marked shipped and its buyer notified\./);
assert.match(complete, /Batch complete/);

assert.match(render(), /No orders have production postage\. Buy postage in production mode first\./);

console.log("PASS ship step reports tracking and shipped messages per order and when the batch is complete");
