import assert from "node:assert/strict";
import {
  escapeSqlLikePattern,
  matchesNumberField,
  shouldSearchRawCardNumberText,
} from "./numberFieldMatching";

type TestCase = {
  name: string;
  run: () => void;
};

const testCases: TestCase[] = [
  {
    name: "numeric searches keep normalized prefix matching",
    run: () => {
      assert.equal(matchesNumberField("3", "003/120"), true);
      assert.equal(matchesNumberField("3", "03/120"), true);
      assert.equal(matchesNumberField("3", "13/120"), false);
      assert.equal(shouldSearchRawCardNumberText("3"), false);
    },
  },
  {
    name: "leading zero numeric searches match normalized card numbers",
    run: () => {
      assert.equal(matchesNumberField("003", "3"), true);
      assert.equal(matchesNumberField("003", "0003/120"), true);
      assert.equal(matchesNumberField("003", "30/120"), false);
      assert.equal(shouldSearchRawCardNumberText("003"), false);
    },
  },
  {
    name: "slash searches keep normalized full-number matching",
    run: () => {
      assert.equal(matchesNumberField("3/120", "003/120"), true);
      assert.equal(matchesNumberField("003/120", "3/120"), true);
      assert.equal(matchesNumberField("3/120", "3/121"), false);
      assert.equal(shouldSearchRawCardNumberText("3/120"), false);
    },
  },
  {
    name: "lettered card numbers use raw text search",
    run: () => {
      assert.equal(shouldSearchRawCardNumberText("OP13-119"), true);
      assert.equal(shouldSearchRawCardNumberText("SWSH029"), true);
      assert.equal(matchesNumberField("OP13-119", "OP13-119"), true);
      assert.equal(matchesNumberField("SWSH029", "SWSH029"), true);
    },
  },
  {
    name: "non-slash punctuation uses raw text search",
    run: () => {
      assert.equal(shouldSearchRawCardNumberText("3-120"), true);
      assert.equal(shouldSearchRawCardNumberText("3.120"), true);
    },
  },
  {
    name: "sql like wildcards are escaped as literal search text",
    run: () => {
      assert.equal(escapeSqlLikePattern("%_\\"), "\\%\\_\\\\");
      assert.equal(escapeSqlLikePattern("OP13-119"), "OP13-119");
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
  console.log(`Passed ${testCases.length} number field matching tests.`);
}
