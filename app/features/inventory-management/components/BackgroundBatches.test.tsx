import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { BackgroundBatches } from "./BackgroundBatches";
import type { InventoryIntakeRun } from "../types/inventoryIntakeRun";

const run: InventoryIntakeRun = {
  batchNumber: 4,
  workflow: "price_only",
  planningStatus: "waiting",
  planningError: null,
  pricingStatus: "pricing",
  pricingError: null,
  itemCount: 2,
  quantity: 3,
  publishedCount: 0,
  publishingCount: 0,
  reviewCount: 0,
  createdAt: "",
  recordedCostCents: null,
  uncostedLotCount: 0,
  hasEnteredCost: false,
  costRate: null,
};

const render = (runs: InventoryIntakeRun[], { error = null as string | null, publicationPaused = false } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <BackgroundBatches runs={runs} error={error} publicationPaused={publicationPaused} onRunChanged={() => {}} />
    </MemoryRouter>,
  );

const quiet = render([]);
assert.match(quiet, /Background batches:/);
assert.match(quiet, /none running/);
assert.doesNotMatch(quiet, /Batch 4|Change rate/, "the batch list stays closed until asked for");
assert.doesNotMatch(quiet, /MuiButton-colorWarning/);

const busy = render([run, { ...run, batchNumber: 5, pricingStatus: "failed" }]);
assert.match(busy, /1 running, 1 needs review/);
assert.match(busy, /MuiButton-colorWarning/);
assert.match(busy, /MuiBadge-badge[^"]*"[^>]*>1</);

assert.match(render([], { error: "down" }), /status unavailable/);
assert.match(render([], { error: "down" }), /MuiButton-colorWarning/);
assert.match(render([], { publicationPaused: true }), /MuiButton-colorWarning/);

console.log("PASS background batches stay a one-line status that flags failures, reviews, outages, and paused publication");
