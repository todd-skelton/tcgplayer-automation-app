import assert from "node:assert/strict";
import {
  clearSavedShippingWorkflow,
  readSavedShippingWorkflow,
  writeSavedShippingWorkflow,
  type SavedShippingWorkflowInput,
  type SavedShippingWorkflowStorage,
} from "./savedShippingWorkflow";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => void;
};

function createMemoryStorage(): SavedShippingWorkflowStorage {
  const data = new Map<string, string>();

  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function createInput(
  overrides: Partial<SavedShippingWorkflowInput> = {},
): SavedShippingWorkflowInput {
  return {
    currentStep: 5,
    sellerKey: "8520a14f",
    loadedSourceLabel: "Live seller orders: 8520a14f",
    loadWarnings: [],
    sourceOrders: [{ "Order #": "A-1", "Tracking #": "" } as TcgPlayerShippingOrder],
    returnPurchaseResultsByReference: {},
    packedOrderNumbers: ["A-1"],
    trackingApplyResults: [],
    shippedMessageResults: [],
    ...overrides,
  };
}

function writeRaw(storage: SavedShippingWorkflowStorage, value: unknown): void {
  storage.setItem("shipping-workflow", JSON.stringify(value));
}

const testCases: TestCase[] = [
  {
    name: "writeSavedShippingWorkflow round-trips the workflow through storage",
    run: () => {
      const storage = createMemoryStorage();

      writeSavedShippingWorkflow(storage, createInput());
      const restored = readSavedShippingWorkflow(storage);

      assert.ok(restored);
      assert.equal(restored.version, 1);
      assert.ok(!Number.isNaN(Date.parse(restored.savedAt)));
      assert.equal(restored.currentStep, 5);
      assert.equal(restored.sellerKey, "8520a14f");
      assert.deepEqual(restored.packedOrderNumbers, ["A-1"]);
      assert.equal(restored.sourceOrders[0]?.["Order #"], "A-1");
    },
  },
  {
    name: "writeSavedShippingWorkflow clears storage when no orders are loaded",
    run: () => {
      const storage = createMemoryStorage();

      writeSavedShippingWorkflow(storage, createInput());
      writeSavedShippingWorkflow(storage, createInput({ sourceOrders: [] }));

      assert.equal(readSavedShippingWorkflow(storage), null);
    },
  },
  {
    name: "clearSavedShippingWorkflow removes the saved workflow",
    run: () => {
      const storage = createMemoryStorage();

      writeSavedShippingWorkflow(storage, createInput());
      clearSavedShippingWorkflow(storage);

      assert.equal(readSavedShippingWorkflow(storage), null);
    },
  },
  {
    name: "readSavedShippingWorkflow rejects missing, malformed, outdated, and incomplete data",
    run: () => {
      const storage = createMemoryStorage();
      const valid = { ...createInput(), version: 1, savedAt: "2026-09-05T14:51:22Z" };

      assert.equal(readSavedShippingWorkflow(storage), null);

      storage.setItem("shipping-workflow", "not json");
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, []);
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, version: 0 });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, savedAt: "yesterday" });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, sourceOrders: [] });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, sourceOrders: [null] });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, sourceOrders: [{ "Order #": "A-1" }] });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, trackingApplyResults: [null] });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, packedOrderNumbers: [1] });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, returnPurchaseResultsByReference: { "A-1": {} } });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, loadWarnings: [{}] });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, { ...valid, packedOrderNumbers: undefined });
      assert.equal(readSavedShippingWorkflow(storage), null);

      writeRaw(storage, valid);
      assert.ok(readSavedShippingWorkflow(storage));
    },
  },
  {
    name: "saved workflow helpers survive a storage that throws",
    run: () => {
      const storage: SavedShippingWorkflowStorage = {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      };
      const originalWarn = console.warn;
      let warningCount = 0;
      console.warn = () => {
        warningCount += 1;
      };

      try {
        assert.equal(readSavedShippingWorkflow(storage), null);
        assert.doesNotThrow(() => writeSavedShippingWorkflow(storage, createInput()));
        assert.doesNotThrow(() => clearSavedShippingWorkflow(storage));
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(warningCount, 3);
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
  console.log(`Passed ${testCases.length} saved shipping workflow tests.`);
}
