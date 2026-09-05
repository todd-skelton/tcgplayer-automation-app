import assert from "node:assert/strict";
import {
  buildConditionLadder,
  estimateRefund,
  type LadderInput,
} from "./conditionLadder";

type TestCase = {
  name: string;
  run: () => void;
};

function ladderRows(inputs: LadderInput[]) {
  return [...buildConditionLadder(inputs).values()].map((step) => [
    step.condition,
    step.price,
    step.aboveBetterCondition,
  ]);
}

const testCases: TestCase[] = [
  {
    name: "ladder keeps prices that already fall from best to worst condition",
    run: () => {
      assert.deepEqual(
        ladderRows([
          { condition: "Damaged", price: 9.24 },
          { condition: "Near Mint", price: 11.39 },
          { condition: "Lightly Played", price: 10.63 },
        ]),
        [
          ["Near Mint", 11.39, false],
          ["Lightly Played", 10.63, false],
          ["Damaged", 9.24, false],
        ],
      );
    },
  },
  {
    name: "ladder clamps a worse condition priced above a better one and flags it",
    run: () => {
      assert.deepEqual(
        ladderRows([
          { condition: "Near Mint", price: 10.61 },
          { condition: "Lightly Played", price: 11.22 },
          { condition: "Moderately Played", price: 11.1 },
          { condition: "Heavily Played", price: 12.19 },
          { condition: "Damaged", price: 10.01 },
        ]),
        [
          ["Near Mint", 10.61, false],
          ["Lightly Played", 10.61, true],
          ["Moderately Played", 10.61, true],
          ["Heavily Played", 10.61, true],
          ["Damaged", 10.01, false],
        ],
      );
    },
  },
  {
    name: "ladder skips conditions without a price and does not let them raise the ceiling",
    run: () => {
      assert.deepEqual(
        ladderRows([
          { condition: "Near Mint", price: 10 },
          { condition: "Lightly Played", price: null },
          { condition: "Moderately Played", price: 12 },
        ]),
        [
          ["Near Mint", 10, false],
          ["Lightly Played", null, false],
          ["Moderately Played", 10, true],
        ],
      );
    },
  },
  {
    name: "ladder compares prices in cents so sub-cent slack cannot leave a step out of order",
    run: () => {
      assert.deepEqual(
        ladderRows([
          { condition: "Near Mint", price: 10.004 },
          { condition: "Lightly Played", price: 10.008 },
          { condition: "Moderately Played", price: 9.996 },
        ]),
        [
          ["Near Mint", 10, false],
          ["Lightly Played", 10, true],
          ["Moderately Played", 10, false],
        ],
      );
    },
  },
  {
    name: "ladder leaves conditions outside the graded order alone",
    run: () => {
      assert.deepEqual(
        ladderRows([
          { condition: "Unopened", price: 40 },
          { condition: "Near Mint", price: 10 },
          { condition: "Damaged", price: 12 },
        ]),
        [
          ["Unopened", 40, false],
          ["Near Mint", 10, false],
          ["Damaged", 10, true],
        ],
      );
    },
  },
  {
    name: "ladder steps are keyed by condition",
    run: () => {
      const ladder = buildConditionLadder([
        { condition: "Near Mint", price: 10 },
        { condition: "Damaged", price: 4 },
      ]);

      assert.equal(ladder.get("Damaged")?.price, 4);
      assert.equal(ladder.get("Lightly Played"), undefined);
    },
  },
  {
    name: "refund leaves the buyer paying the received condition's share of the price",
    run: () => {
      const estimate = estimateRefund({
        pricePaid: 12,
        soldConditionPrice: 10,
        receivedConditionPrice: 7.5,
      });

      assert.deepEqual(estimate, {
        retainedShare: 0.75,
        refund: 3,
        netPrice: 9,
      });
    },
  },
  {
    name: "refund is zero when the received condition is worth as much or more",
    run: () => {
      const estimate = estimateRefund({
        pricePaid: 12,
        soldConditionPrice: 10,
        receivedConditionPrice: 10.5,
      });

      assert.deepEqual(estimate, { retainedShare: 1, refund: 0, netPrice: 12 });
    },
  },
  {
    name: "refund is unavailable without a positive price on every input",
    run: () => {
      assert.equal(
        estimateRefund({ pricePaid: null, soldConditionPrice: 10, receivedConditionPrice: 5 }),
        null,
      );
      assert.equal(
        estimateRefund({ pricePaid: 0, soldConditionPrice: 10, receivedConditionPrice: 5 }),
        null,
      );
      assert.equal(
        estimateRefund({ pricePaid: 12, soldConditionPrice: null, receivedConditionPrice: 5 }),
        null,
      );
      assert.equal(
        estimateRefund({ pricePaid: 12, soldConditionPrice: 10, receivedConditionPrice: null }),
        null,
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
  console.log(`Passed ${testCases.length} condition ladder tests.`);
}
