import assert from "node:assert/strict";
import type { TcgPlayerListing } from "~/core/types/pricing";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import type {
  InventoryBatch,
  InventoryBatchItem,
  InventoryBatchResult,
} from "~/features/pending-inventory/types/inventoryBatch";
import type {
  CreateInventoryPublication,
  InventoryPublication,
  InventoryPublicationItemStatus,
} from "../types/inventoryPublication";
import {
  planInventoryBatchPublication,
  previewInventoryBatchPublication,
} from "./inventoryBatchPublication.server";

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

const NOW = new Date("2026-08-05T12:00:00.000Z");
const PRICED_AT = new Date("2026-08-05T11:30:00.000Z");

function createRow(): TcgPlayerListing {
  return {
    "TCGplayer Id": "5199433",
    "Product Line": "Pokemon",
    "Set Name": "Celebrations",
    Product: "Greninja Star",
    "Sku Variant": "Holofoil",
    "Sku Condition": "Near Mint Holofoil",
    "Sale Count": "10",
    "Lowest Sale Price": "22.00",
    "Highest Sale Price": "29.00",
    "TCG Market Price": "24.00",
    "Total Quantity": "0",
    "Add to Quantity": "2",
    "TCG Marketplace Price": "24.99",
    "Previous Price": "",
    "Suggested Price": "24.99",
    "Percentile Used": "65",
    "Historical Sales Velocity (Days)": "10",
    "Estimated Time to Sell (Days)": "12",
    "Sales Count for Historical Calculation": "10",
    "Listings Count for Estimated Calculation": "20",
    Error: "",
    Warning: "",
  };
}

function createBatch(
  sourceType: InventoryBatch["sourceType"] = "pending_inventory",
): InventoryBatch {
  return {
    batchNumber: 90,
    status: "priced",
    sourceType,
    sourceLabel: sourceType === "seller" ? "test-seller" : "Inventory Manager",
    createdAt: new Date("2026-08-05T11:00:00.000Z"),
    updatedAt: PRICED_AT,
    lastPricedAt: PRICED_AT,
    summary: null,
    successfulCount: 1,
    manualReviewCount: 0,
    itemCount: 1,
    latestJob: {
      id: 21,
      batchNumber: 90,
      priority: 300,
      mode: "full",
      status: "completed",
      config: DEFAULT_SERVER_PRICING_CONFIG,
      progress: null,
      summary: null,
      errorMessage: null,
      attemptCount: 1,
      claimedBy: null,
      claimExpiresAt: null,
      startedAt: new Date("2026-08-05T11:20:00.000Z"),
      completedAt: PRICED_AT,
      createdAt: new Date("2026-08-05T11:15:00.000Z"),
      updatedAt: PRICED_AT,
    },
  };
}

function createBatchItem(
  overrides: Partial<InventoryBatchItem> = {},
): InventoryBatchItem {
  return {
    batchNumber: 90,
    sku: 5199433,
    totalQuantity: 0,
    addToQuantity: 2,
    currentPrice: null,
    productLineId: 3,
    setId: 123,
    productId: 248731,
    originalRow: null,
    createdAt: new Date("2026-08-05T11:00:00.000Z"),
    updatedAt: new Date("2026-08-05T11:00:00.000Z"),
    ...overrides,
  };
}

function createResult(
  overrides: Partial<InventoryBatchResult> = {},
): InventoryBatchResult {
  return {
    batchNumber: 90,
    sku: 5199433,
    resultStatus: "successful",
    row: createRow(),
    pricingDetails: {
      schemaVersion: 1,
      pricedAt: PRICED_AT.toISOString(),
      marketplacePrice: 24.99,
      previousPrice: undefined,
      quantity: 0,
      addToQuantity: 2,
    },
    errorMessages: [],
    warningMessages: [],
    pricedAt: PRICED_AT,
    ...overrides,
  };
}

function createPublication(
  params: CreateInventoryPublication,
): InventoryPublication {
  return {
    id: 7,
    planningKey: params.planningKey,
    batchNumber: params.batchNumber ?? null,
    pricingJobId: params.pricingJobId ?? null,
    method: params.method,
    sourceType: params.sourceType,
    sellerKey: params.sellerKey ?? null,
    status: "planned",
    stagedPricingUploadId: null,
    config: params.config ?? {},
    progress: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    claimedBy: null,
    claimExpiresAt: null,
    stagedAt: null,
    publishingAt: null,
    publishedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    items: params.items.map((item, index) => ({
      id: index + 1,
      publicationId: 7,
      candidateKey: item.candidateKey,
      inventoryDeltaKey: item.inventoryDeltaKey ?? null,
      batchNumber: item.batchNumber ?? null,
      sku: item.sku,
      productId: item.productId,
      productLine: item.productLine,
      setName: item.setName,
      productName: item.productName,
      condition: item.condition,
      previousPrice: item.previousPrice ?? null,
      desiredPrice: item.desiredPrice,
      quantityDelta: item.quantityDelta,
      observedQuantity: item.observedQuantity ?? null,
      desiredAbsoluteQuantity: item.desiredAbsoluteQuantity ?? null,
      pricedAt: item.pricedAt,
      eligibilityReasons: item.eligibilityReasons ?? [],
      status: item.status ?? "planned",
      errorCode: null,
      errorMessage: null,
      publishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };
}

function createDependencies(
  options: {
    sourceType?: InventoryBatch["sourceType"];
    deltaStatus?: InventoryPublicationItemStatus;
    candidateAlreadyUsed?: boolean;
    batchItem?: InventoryBatchItem;
    result?: InventoryBatchResult;
  } = {},
) {
  const created: CreateInventoryPublication[] = [];
  const deltaStatuses = new Map<string, InventoryPublicationItemStatus>();
  const existingCandidateKeys = new Set<string>();
  if (options.deltaStatus) {
    deltaStatuses.set("inventory-batch-item:90:5199433", options.deltaStatus);
  }
  if (options.candidateAlreadyUsed) {
    existingCandidateKeys.add(
      "pricing-result:90:5199433:2026-08-05T11:30:00.000Z",
    );
  }

  return {
    created,
    dependencies: {
      findBatch: async () => createBatch(options.sourceType),
      findItems: async () => [options.batchItem ?? createBatchItem()],
      findSuccessfulResults: async () => [options.result ?? createResult()],
      findInventoryDeltaStatuses: async () => deltaStatuses,
      findExistingPricingCandidateKeys: async () => existingCandidateKeys,
      createPublication: async (params: CreateInventoryPublication) => {
        created.push(params);
        return {
          publication: createPublication(params),
          created: true,
        };
      },
    },
  };
}

const testCases: TestCase[] = [
  {
    name: "manual preview accepts new inventory while automatic publishing is disabled",
    run: async () => {
      const { dependencies } = createDependencies();
      const preview = await previewInventoryBatchPublication(90, {
        dependencies,
        now: NOW,
      });

      assert.equal(preview.eligibleCount, 1);
      assert.equal(preview.items[0]?.quantityDelta, 2);
      assert.deepEqual(preview.items[0]?.reasons, []);
    },
  },
  {
    name: "staged conditions include non-normal printing variants",
    run: async () => {
      const result = createResult({
        row: {
          ...createRow(),
          "Sku Condition": "Near Mint",
          "Sku Variant": "Holofoil",
        },
      });
      const preview = await previewInventoryBatchPublication(90, {
        dependencies: createDependencies({ result }).dependencies,
        now: NOW,
      });

      assert.equal(preview.items[0]?.condition, "Near Mint Holofoil");
    },
  },
  {
    name: "publication uses frozen catalog metadata instead of enriched result labels",
    run: async () => {
      const originalRow = {
        ...createRow(),
        Product: "Greninja Star",
      };
      const result = createResult({
        row: {
          ...originalRow,
          Product: "Greninja Star - Promo",
        },
      });
      const preview = await previewInventoryBatchPublication(90, {
        dependencies: createDependencies({
          result,
          batchItem: createBatchItem({ originalRow }),
        }).dependencies,
        now: NOW,
      });

      assert.equal(preview.items[0]?.productName, "Greninja Star");
    },
  },
  {
    name: "published candidates are not offered twice while later repricing stays price-only",
    run: async () => {
      const published = await previewInventoryBatchPublication(90, {
        dependencies: createDependencies({
          deltaStatus: "published",
          candidateAlreadyUsed: true,
        }).dependencies,
        now: NOW,
      });
      const repriced = await previewInventoryBatchPublication(90, {
        dependencies: createDependencies({
          deltaStatus: "published",
        }).dependencies,
        now: NOW,
      });
      const ambiguous = await previewInventoryBatchPublication(90, {
        dependencies: createDependencies({
          deltaStatus: "ambiguous",
        }).dependencies,
        now: NOW,
      });

      assert.equal(published.items[0]?.quantityDelta, 0);
      assert.equal(published.items[0]?.eligible, false);
      assert.ok(
        published.items[0]?.reasons.includes(
          "pricing_candidate_already_used",
        ),
      );
      assert.equal(repriced.items[0]?.quantityDelta, 0);
      assert.equal(repriced.items[0]?.eligible, true);
      assert.equal(ambiguous.items[0]?.eligible, false);
      assert.ok(
        ambiguous.items[0]?.reasons.includes("inventory_delta_ambiguous"),
      );
    },
  },
  {
    name: "CSV quantity deltas require review and eligible plans persist stable keys",
    run: async () => {
      const csv = await previewInventoryBatchPublication(90, {
        dependencies: createDependencies({ sourceType: "csv" }).dependencies,
        now: NOW,
      });
      assert.ok(
        csv.items[0]?.reasons.includes("csv_quantity_delta_requires_review"),
      );

      const { dependencies, created } = createDependencies();
      const planned = await planInventoryBatchPublication(90, {
        dependencies,
        now: NOW,
      });

      assert.equal(planned.created, true);
      assert.equal(created[0]?.planningKey, "inventory-batch-pricing-job:21");
      assert.equal(
        created[0]?.items[0]?.inventoryDeltaKey,
        "inventory-batch-item:90:5199433",
      );
      assert.equal(created[0]?.items[0]?.quantityDelta, 2);
    },
  },
  {
    name: "manual plans persist only the selected eligible SKUs",
    run: async () => {
      const { dependencies, created } = createDependencies();
      const planned = await planInventoryBatchPublication(90, {
        dependencies,
        now: NOW,
        selectedSkus: [5199433, 5199433],
      });

      assert.match(
        planned.publication.planningKey,
        /^inventory-batch-pricing-job:21:selection:[0-9a-f]{16}$/,
      );
      assert.deepEqual(created[0]?.config?.selectedSkus, [5199433]);
      assert.deepEqual(
        created[0]?.items.map((item) => item.sku),
        [5199433],
      );
      assert.equal(
        planned.preview.planningKey,
        planned.publication.planningKey,
      );
    },
  },
  {
    name: "manual selection rejects missing, ineligible, and empty SKU sets",
    run: async () => {
      const { dependencies } = createDependencies();
      await assert.rejects(
        planInventoryBatchPublication(90, {
          dependencies,
          now: NOW,
          selectedSkus: [123456],
        }),
        /missing or ineligible: 123456/,
      );
      await assert.rejects(
        planInventoryBatchPublication(90, {
          dependencies,
          now: NOW,
          selectedSkus: [],
        }),
        /Select at least one valid SKU/,
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
  console.log(`Passed ${testCases.length} inventory batch publication tests.`);
}
