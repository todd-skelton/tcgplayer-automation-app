import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueueBar } from "./QueueBar";
import { DEFAULT_NEXT_BATCH_COST, type NextBatchCost } from "../services/nextBatchCost";
import type { IntakePublicationTarget, InventoryIntakeWorkflow } from "../types/inventoryIntakeRun";

const target: IntakePublicationTarget = {
  sellerKey: "seller",
  publicationSellerKey: "seller",
  canPublish: true,
  publishingUnavailableReason: null,
  publicationPaused: false,
};

const render = ({
  workflow = "price_only" as InventoryIntakeWorkflow,
  intakeTarget = target as IntakePublicationTarget | null,
  cost = DEFAULT_NEXT_BATCH_COST as NextBatchCost,
  queuing = false,
} = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <QueueBar
        units={3}
        skuCount={2}
        cost={cost}
        onCostChange={() => {}}
        workflow={workflow}
        onWorkflowChange={() => {}}
        target={intakeTarget}
        queuing={queuing}
        onQueue={() => {}}
        onClear={() => {}}
      />
    </MemoryRouter>,
  );

const disabledButton = (label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}`);

const ready = render();
assert.match(ready, /3 unqueued units across 2 SKUs/);
assert.match(ready, /Cost: Default estimate: /);
assert.match(ready, />Queue pricing only/);
assert.doesNotMatch(ready, disabledButton("Queue pricing only"));
assert.doesNotMatch(ready, /Cost of the next batch/, "cost fields stay behind the cost summary until asked for");

assert.match(render({ intakeTarget: null }), /Waiting for batch status before queuing\./);
assert.match(render({ intakeTarget: null }), disabledButton("Queue pricing only"));

const blockedPublish = render({
  workflow: "publish",
  intakeTarget: { ...target, canPublish: false, publishingUnavailableReason: "No publication seller is configured." },
});
assert.match(blockedPublish, /No publication seller is configured\./);
assert.match(blockedPublish, /href="\/publication-configuration"/);
assert.match(blockedPublish, disabledButton("Queue pricing &amp; publishing"));

const incompletePurchase = render({ cost: { ...DEFAULT_NEXT_BATCH_COST, method: "purchase_total" } });
assert.match(incompletePurchase, /Cost: Purchase total: needs a reference and total/);
assert.match(incompletePurchase, /Enter the purchase reference and total before queuing\./);
assert.match(incompletePurchase, disabledButton("Queue pricing only"));

assert.match(render({ queuing: true }), disabledButton("Saving &amp; queuing\\.\\.\\."));

console.log("PASS queue bar shows unqueued totals and names what blocks queuing for the chosen workflow and cost");
