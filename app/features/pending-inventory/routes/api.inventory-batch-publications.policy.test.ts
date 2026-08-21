import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./api.inventory-batch-publications.ts", import.meta.url),
  "utf8",
);

function assertUsesStoredPolicy(call: string): void {
  const callStart = source.indexOf(call);
  const callEnd = source.indexOf("});", callStart);

  assert.ok(callStart >= 0, `${call} must be present.`);
  assert.ok(callEnd > callStart, `${call} must pass options.`);
  assert.match(
    source.slice(callStart, callEnd),
    /policy: configuration\.settings\.policy/,
    `${call} must use the stored publication policy.`,
  );
}

assertUsesStoredPolicy("previewInventoryBatchPublication(batchNumber");
assertUsesStoredPolicy("planInventoryBatchPublications(batchNumber");

console.log("PASS manual inventory publication uses the stored policy");
