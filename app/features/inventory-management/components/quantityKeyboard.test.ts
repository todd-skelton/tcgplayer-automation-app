import assert from "node:assert/strict";
import {
  getAdjacentVisibleQuantityRowId,
  getQuantityKeyboardAction,
} from "./quantityKeyboard";

type TestCase = {
  name: string;
  run: () => void;
};

const testCases: TestCase[] = [
  {
    name: "Enter increments quantity only when the field is untouched",
    run: () => {
      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "Enter",
          code: "Enter",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "submit", incrementQuantity: true },
      );

      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "Enter",
          code: "Enter",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: false,
        }),
        { type: "submit", incrementQuantity: false },
      );
    },
  },
  {
    name: "plus and minus keys adjust quantity in place",
    run: () => {
      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "+",
          code: "Equal",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "adjust-quantity", amount: 1 },
      );

      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "-",
          code: "Minus",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "adjust-quantity", amount: -1 },
      );

      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "",
          code: "NumpadAdd",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "adjust-quantity", amount: 1 },
      );
    },
  },
  {
    name: "plain arrow keys move between quantity inputs while ctrl arrows change condition",
    run: () => {
      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "ArrowUp",
          code: "ArrowUp",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "move-focus", direction: "previous" },
      );

      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "ArrowDown",
          code: "ArrowDown",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "move-focus", direction: "next" },
      );

      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "ArrowUp",
          code: "ArrowUp",
          ctrlKey: true,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "change-condition", direction: "previous" },
      );

      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "ArrowDown",
          code: "ArrowDown",
          ctrlKey: true,
          altKey: false,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "change-condition", direction: "next" },
      );
    },
  },
  {
    name: "navigation stays within the visible quantity rows",
    run: () => {
      const rowIds = ["row-1", "row-2", "row-3"];

      assert.equal(
        getAdjacentVisibleQuantityRowId(rowIds, "row-1", "previous"),
        null,
      );
      assert.equal(
        getAdjacentVisibleQuantityRowId(rowIds, "row-1", "next"),
        "row-2",
      );
      assert.equal(
        getAdjacentVisibleQuantityRowId(rowIds, "row-2", "previous"),
        "row-1",
      );
      assert.equal(
        getAdjacentVisibleQuantityRowId(rowIds, "row-2", "next"),
        "row-3",
      );
      assert.equal(
        getAdjacentVisibleQuantityRowId(rowIds, "row-3", "next"),
        null,
      );
    },
  },
  {
    name: "unrelated modifier combinations do not trigger quantity keyboard actions",
    run: () => {
      assert.deepEqual(
        getQuantityKeyboardAction({
          key: "ArrowDown",
          code: "ArrowDown",
          ctrlKey: false,
          altKey: true,
          metaKey: false,
          untouchedSinceFocus: true,
        }),
        { type: "none" },
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
  console.log(`Passed ${testCases.length} quantity keyboard tests.`);
}
