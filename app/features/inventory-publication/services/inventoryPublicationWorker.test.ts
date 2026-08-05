import assert from "node:assert/strict";
import type {
  InventoryPublication,
  InventoryPublicationItem,
  InventoryPublicationItemOutcome,
} from "../types/inventoryPublication";
import {
  buildMoveToLiveOutcomes,
  executeClaimedStagedPublication,
  type InventoryPublicationWorkerDependencies,
  isSellerPortalAuthenticationFailure,
} from "./inventoryPublicationWorker.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const NOW = new Date("2026-08-05T12:00:00.000Z");

function createItem(
  overrides: Partial<InventoryPublicationItem> = {},
): InventoryPublicationItem {
  return {
    id: 11,
    publicationId: 7,
    candidateKey: "pricing-result:90:5199433:2026-08-05T11:30:00.000Z",
    inventoryDeltaKey: "inventory-batch-item:90:5199433",
    batchNumber: 90,
    sku: 5199433,
    productId: 248731,
    productLine: "Pokemon",
    setName: "Celebrations",
    productName: "Greninja Star",
    condition: "Near Mint Holofoil",
    previousPrice: null,
    desiredPrice: 24.99,
    quantityDelta: 1,
    observedQuantity: null,
    desiredAbsoluteQuantity: null,
    pricedAt: NOW,
    eligibilityReasons: [],
    status: "planned",
    errorCode: null,
    errorMessage: null,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPublication(
  overrides: Partial<InventoryPublication> = {},
): InventoryPublication {
  return {
    id: 7,
    planningKey: "inventory-batch-pricing-job:21",
    batchNumber: 90,
    pricingJobId: 21,
    method: "staged_delta",
    sourceType: "pending_inventory",
    sellerKey: null,
    status: "staging",
    stagedPricingUploadId: null,
    config: {},
    progress: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 1,
    claimedBy: "test-worker",
    claimExpiresAt: new Date("2026-08-05T12:01:00.000Z"),
    stagedAt: null,
    publishingAt: null,
    publishedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    items: [createItem()],
    ...overrides,
  };
}

function createDependencies(
  overrides: {
    uploadCount?: number;
    moveError?: Error;
  } = {},
): {
  dependencies: InventoryPublicationWorkerDependencies;
  calls: string[];
  outcomes: InventoryPublicationItemOutcome[];
  markedItems: Array<{ status: string; errorCode: string }>;
} {
  const calls: string[] = [];
  const outcomes: InventoryPublicationItemOutcome[] = [];
  const markedItems: Array<{ status: string; errorCode: string }> = [];

  return {
    calls,
    outcomes,
    markedItems,
    dependencies: {
      initialize: async () => {
        calls.push("initialize");
        return 16104570;
      },
      upload: async ({ updates }) => {
        calls.push(`upload:${updates.length}`);
        return {
          SuccessfulProductCount: overrides.uploadCount ?? updates.length,
        };
      },
      finalize: async () => {
        calls.push("finalize");
      },
      rollback: async () => {
        calls.push("rollback");
      },
      move: async () => {
        calls.push("move");
        if (overrides.moveError) {
          throw overrides.moveError;
        }
        return {
          Success: [],
          Warning: [],
          Error: [],
          Update: [
            {
              ProductConditionId: 5199433,
              StorePriceCustomId: null,
              Message: null,
              ProductName: "Greninja Star",
              ChannelName: "Marketplace",
            },
          ],
        };
      },
      recordUploadId: async () => {
        calls.push("record-upload");
      },
      transition: async (_publicationId, expectedStatus, nextStatus) => {
        calls.push(`transition:${expectedStatus}:${nextStatus}`);
        return createPublication({ status: nextStatus });
      },
      saveItemOutcomes: async (_publicationId, nextOutcomes) => {
        calls.push("save-outcomes");
        outcomes.push(...nextOutcomes);
      },
      markPlannedItems: async (_publicationId, status, errorCode) => {
        calls.push(`mark-items:${status}`);
        markedItems.push({ status, errorCode });
        return 1;
      },
    },
  };
}

const testCases: TestCase[] = [
  {
    name: "staged publication confirms Update items and moves live once",
    run: async () => {
      const { dependencies, calls, outcomes } = createDependencies();

      await executeClaimedStagedPublication(
        createPublication(),
        "test-worker",
        dependencies,
      );

      assert.deepEqual(calls, [
        "initialize",
        "record-upload",
        "upload:1",
        "finalize",
        "transition:staging:staged",
        "transition:staged:publishing",
        "move",
        "save-outcomes",
        "transition:publishing:published",
      ]);
      assert.deepEqual(outcomes, [{ itemId: 11, status: "published" }]);
    },
  },
  {
    name: "confirmed upload mismatch rolls back before move-to-live",
    run: async () => {
      const { dependencies, calls, markedItems } = createDependencies({
        uploadCount: 0,
      });

      await executeClaimedStagedPublication(
        createPublication(),
        "test-worker",
        dependencies,
      );

      assert.ok(calls.includes("rollback"));
      assert.ok(!calls.includes("move"));
      assert.ok(calls.includes("transition:staging:rolled_back"));
      assert.deepEqual(markedItems, [
        {
          status: "failed",
          errorCode: "staged_publication_rolled_back",
        },
      ]);
    },
  },
  {
    name: "lost move-to-live response becomes ambiguous without rollback",
    run: async () => {
      const { dependencies, calls, markedItems } = createDependencies({
        moveError: new Error("connection reset"),
      });

      await executeClaimedStagedPublication(
        createPublication(),
        "test-worker",
        dependencies,
      );

      assert.ok(calls.includes("move"));
      assert.ok(!calls.includes("rollback"));
      assert.ok(calls.includes("transition:publishing:ambiguous"));
      assert.deepEqual(markedItems, [
        {
          status: "ambiguous",
          errorCode: "move_to_live_ambiguous",
        },
      ]);
    },
  },
  {
    name: "move-to-live response maps errors, warnings, and missing rows conservatively",
    run: () => {
      const outcomes = buildMoveToLiveOutcomes(
        [
          createItem({ id: 1, sku: 1 }),
          createItem({ id: 2, sku: 2 }),
          createItem({ id: 3, sku: 3 }),
        ],
        {
          Success: [],
          Update: [
            {
              ProductConditionId: 1,
              StorePriceCustomId: null,
              Message: null,
              ProductName: "One",
              ChannelName: "Marketplace",
            },
          ],
          Warning: [
            {
              ProductConditionId: 2,
              StorePriceCustomId: null,
              Message: "Review warning",
              ProductName: "Two",
              ChannelName: "Marketplace",
            },
          ],
          Error: [],
        },
      );

      assert.deepEqual(
        outcomes.map(({ itemId, status }) => ({ itemId, status })),
        [
          { itemId: 1, status: "published" },
          { itemId: 2, status: "ambiguous" },
          { itemId: 3, status: "ambiguous" },
        ],
      );
    },
  },
  {
    name: "Seller Portal authentication failures are classified conservatively",
    run: () => {
      assert.equal(
        isSellerPortalAuthenticationFailure({ response: { status: 401 } }),
        true,
      );
      assert.equal(
        isSellerPortalAuthenticationFailure(new Error("Login required")),
        true,
      );
      assert.equal(
        isSellerPortalAuthenticationFailure(new Error("timeout")),
        false,
      );
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    await testCase.run();
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
  console.log(`Passed ${testCases.length} inventory publication worker tests.`);
}
