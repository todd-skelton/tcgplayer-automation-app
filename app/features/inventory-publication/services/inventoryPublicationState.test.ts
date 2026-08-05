import assert from "node:assert/strict";
import {
  canTransitionInventoryPublication,
  requireInventoryPublicationTransition,
} from "./inventoryPublicationState";

type TestCase = {
  name: string;
  run: () => void;
};

const testCases: TestCase[] = [
  {
    name: "publication lifecycle permits the staged happy path",
    run: () => {
      assert.equal(
        canTransitionInventoryPublication("planned", "staging"),
        true,
      );
      assert.equal(
        canTransitionInventoryPublication("staging", "staged"),
        true,
      );
      assert.equal(
        canTransitionInventoryPublication("staged", "publishing"),
        true,
      );
      assert.equal(
        canTransitionInventoryPublication("publishing", "published"),
        true,
      );
    },
  },
  {
    name: "ambiguous publications require reconciliation",
    run: () => {
      assert.equal(
        canTransitionInventoryPublication("publishing", "ambiguous"),
        true,
      );
      assert.equal(
        canTransitionInventoryPublication("ambiguous", "published"),
        true,
      );
      assert.equal(
        canTransitionInventoryPublication("ambiguous", "failed"),
        true,
      );
      assert.equal(
        canTransitionInventoryPublication("ambiguous", "publishing"),
        false,
      );
    },
  },
  {
    name: "published publications are terminal",
    run: () => {
      assert.equal(
        canTransitionInventoryPublication("published", "staging"),
        false,
      );
      assert.throws(
        () => requireInventoryPublicationTransition("published", "failed"),
        /cannot transition from published to failed/,
      );
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
  console.log(`Passed ${testCases.length} inventory publication state tests.`);
}
