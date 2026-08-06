import assert from "node:assert/strict";
import {
  createInventoryDeltaKey,
  createPricingCandidateKey,
  evaluateInventoryPublicationCandidate,
  getInventoryPublicationMethod,
} from "./inventoryPublicationPolicy";
import {
  DEFAULT_INVENTORY_PUBLICATION_POLICY,
  type InventoryPublicationCandidate,
  type InventoryPublicationPolicy,
} from "../types/inventoryPublication";

type TestCase = {
  name: string;
  run: () => void;
};

const NOW = new Date("2026-08-05T12:00:00.000Z");

function createEnabledPolicy(
  overrides: Partial<InventoryPublicationPolicy> = {},
): InventoryPublicationPolicy {
  return {
    ...DEFAULT_INVENTORY_PUBLICATION_POLICY,
    automaticPublishingEnabled: true,
    automaticSources: {
      ...DEFAULT_INVENTORY_PUBLICATION_POLICY.automaticSources,
      pending_inventory: true,
      seller: true,
    },
    ...overrides,
  };
}

function createCandidate(
  overrides: Partial<InventoryPublicationCandidate> = {},
): InventoryPublicationCandidate {
  return {
    sourceType: "seller",
    batchNumber: 90,
    sku: 5199433,
    price: 24.99,
    previousPrice: 24.57,
    quantityDelta: 0,
    pricedAt: new Date("2026-08-05T11:30:00.000Z"),
    errors: [],
    warnings: [],
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: "automatic publication is disabled by default",
    run: () => {
      const decision = evaluateInventoryPublicationCandidate(
        createCandidate(),
        DEFAULT_INVENTORY_PUBLICATION_POLICY,
        NOW,
      );

      assert.equal(decision.eligible, false);
      assert.deepEqual(decision.reasons, [
        "automatic_publishing_disabled",
        "source_not_enabled",
      ]);
    },
  },
  {
    name: "eligible seller price changes are rounded and accepted",
    run: () => {
      const decision = evaluateInventoryPublicationCandidate(
        createCandidate({ price: 24.994 }),
        createEnabledPolicy(),
        NOW,
      );

      assert.equal(decision.eligible, true);
      assert.equal(decision.roundedPrice, 24.99);
      assert.equal(decision.roundedPreviousPrice, 24.57);
      assert.deepEqual(decision.reasons, []);
    },
  },
  {
    name: "new inventory can publish without a previous price",
    run: () => {
      const decision = evaluateInventoryPublicationCandidate(
        createCandidate({
          sourceType: "pending_inventory",
          previousPrice: null,
          quantityDelta: 3,
        }),
        createEnabledPolicy(),
        NOW,
      );

      assert.equal(decision.eligible, true);
      assert.ok(!decision.reasons.includes("missing_previous_price"));
    },
  },
  {
    name: "warnings, stale candidates, and consumed deltas require review",
    run: () => {
      const decision = evaluateInventoryPublicationCandidate(
        createCandidate({
          sourceType: "pending_inventory",
          previousPrice: null,
          quantityDelta: 3,
          inventoryDeltaConsumed: true,
          warnings: ["No market price available"],
          pricedAt: new Date("2026-08-05T09:00:00.000Z"),
        }),
        createEnabledPolicy(),
        NOW,
      );

      assert.equal(decision.eligible, false);
      assert.deepEqual(decision.reasons, [
        "pricing_warning",
        "inventory_delta_already_consumed",
        "candidate_stale",
      ]);
    },
  },
  {
    name: "previous-price percentages do not block valid cent changes",
    run: () => {
      const policy = createEnabledPolicy();
      const increase = evaluateInventoryPublicationCandidate(
        createCandidate({ previousPrice: 0.01, price: 0.03 }),
        policy,
        NOW,
      );
      const decrease = evaluateInventoryPublicationCandidate(
        createCandidate({ previousPrice: 0.02, price: 0.01 }),
        policy,
        NOW,
      );

      assert.equal(increase.eligible, true);
      assert.deepEqual(increase.reasons, []);
      assert.equal(decrease.eligible, true);
      assert.deepEqual(decrease.reasons, []);
    },
  },
  {
    name: "candidate identities and publication methods are stable",
    run: () => {
      const candidate = createCandidate();

      assert.equal(
        createPricingCandidateKey(candidate),
        "pricing-result:90:5199433:2026-08-05T11:30:00.000Z",
      );
      assert.equal(
        createInventoryDeltaKey(candidate),
        "inventory-batch-item:90:5199433",
      );
      assert.equal(getInventoryPublicationMethod(false), "staged_delta");
      assert.equal(getInventoryPublicationMethod(true), "direct_absolute");
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
  console.log(`Passed ${testCases.length} inventory publication policy tests.`);
}
