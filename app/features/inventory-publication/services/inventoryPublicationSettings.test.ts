import assert from "node:assert/strict";
import {
  DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
  isAutomaticPublicationAvailable,
} from "../types/inventoryPublicationSettings";
import { normalizeInventoryPublicationSettings } from "./inventoryPublicationSettings";

const normalized = normalizeInventoryPublicationSettings({
  globalPaused: false,
  consecutiveFailureLimit: 5,
  policy: {
    automaticPublishingEnabled: true,
    automaticSources: {
      pending_inventory: true,
      seller: false,
      csv: true,
      continuous: true,
    },
    maximumAutomaticDecreasePercent: 15,
    stagedMicroBatchMaximum: 800,
  },
});

assert.equal(normalized.consecutiveFailureLimit, 5);
assert.equal(normalized.policy.automaticSources.pending_inventory, true);
assert.equal(normalized.policy.stagedMicroBatchMaximum, 250);
assert.equal(normalized.policy.maximumAutomaticDecreasePercent, 15);

const configuration = {
  settings: normalized,
  runtime: {
    authenticationStatus: "unknown" as const,
    circuitOpen: false,
    consecutiveFailures: 0,
    pauseReason: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    runtimeUpdatedAt: new Date(),
  },
  updatedAt: new Date(),
};

assert.equal(
  isAutomaticPublicationAvailable(configuration, "pending_inventory"),
  true,
);
assert.equal(isAutomaticPublicationAvailable(configuration, "seller"), false);
assert.equal(
  isAutomaticPublicationAvailable(
    {
      ...configuration,
      runtime: { ...configuration.runtime, authenticationStatus: "invalid" },
    },
    "pending_inventory",
  ),
  false,
);
assert.equal(
  DEFAULT_INVENTORY_PUBLICATION_SETTINGS.policy.automaticPublishingEnabled,
  false,
);

console.log(
  "PASS inventory publication settings normalize safe automatic controls",
);
