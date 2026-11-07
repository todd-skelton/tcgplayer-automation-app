import assert from "node:assert/strict";
import { nodeWorkerServices } from "./nodeWorkers.mjs";

assert.deepEqual(
  nodeWorkerServices({}),
  { running: ["pricing-worker", "pricing-scheduler", "slab-evidence-worker", "publication-worker"], retired: [] },
  "with no switch set every Node worker runs",
);
assert.deepEqual(
  nodeWorkerServices({ PRICING_WORKER: "1", SELLER_ORDER_HISTORY_WORKER: "1" }),
  { running: ["pricing-scheduler", "slab-evidence-worker", "publication-worker"], retired: ["pricing-worker"] },
  "the pricing switch retires Node's pricing worker; order history has no service of its own",
);
assert.deepEqual(
  nodeWorkerServices({ PRICING_WORKER: "  ", CONTINUOUS_PRICING_SCHEDULER: "true" }),
  { running: ["pricing-worker", "slab-evidence-worker", "publication-worker"], retired: ["pricing-scheduler"] },
  "a blank switch is unset, as the Corten app reads it",
);
assert.deepEqual(
  nodeWorkerServices({
    PRICING_WORKER: "1",
    CONTINUOUS_PRICING_SCHEDULER: "1",
    SLAB_EVIDENCE_WORKER: "1",
    PUBLICATION_WORKER: "1",
  }),
  { running: [], retired: ["pricing-worker", "pricing-scheduler", "slab-evidence-worker", "publication-worker"] },
);