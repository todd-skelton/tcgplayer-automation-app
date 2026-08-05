import assert from "node:assert/strict";
import {
  DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
} from "~/features/inventory-publication/types/inventoryPublicationSettings";
import { getPool } from "../database.server";
import { inventoryPublicationSettingsRepository } from "./inventoryPublicationSettings.server";

try {
  const saved = await inventoryPublicationSettingsRepository.save({
    ...DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
    consecutiveFailureLimit: 2,
    policy: {
      ...DEFAULT_INVENTORY_PUBLICATION_SETTINGS.policy,
      automaticPublishingEnabled: true,
      automaticSources: {
        ...DEFAULT_INVENTORY_PUBLICATION_SETTINGS.policy.automaticSources,
        pending_inventory: true,
      },
    },
  });
  assert.equal(saved.settings.policy.automaticPublishingEnabled, true);
  assert.equal(saved.runtime.circuitOpen, false);

  const firstFailure =
    await inventoryPublicationSettingsRepository.recordFailure({
      authenticationFailure: false,
      consecutiveFailureLimit: 2,
      message: "temporary Seller Portal failure",
    });
  assert.equal(firstFailure.runtime.consecutiveFailures, 1);
  assert.equal(firstFailure.runtime.circuitOpen, false);

  const secondFailure =
    await inventoryPublicationSettingsRepository.recordFailure({
      authenticationFailure: false,
      consecutiveFailureLimit: 2,
      message: "second Seller Portal failure",
    });
  assert.equal(secondFailure.runtime.circuitOpen, true);

  const resumed = await inventoryPublicationSettingsRepository.resume();
  assert.equal(resumed.runtime.circuitOpen, false);
  assert.equal(resumed.runtime.consecutiveFailures, 0);

  const authenticationFailure =
    await inventoryPublicationSettingsRepository.recordFailure({
      authenticationFailure: true,
      consecutiveFailureLimit: 2,
      message: "login required",
    });
  assert.equal(authenticationFailure.runtime.authenticationStatus, "invalid");
  assert.equal(authenticationFailure.runtime.circuitOpen, true);

  const healthy = await inventoryPublicationSettingsRepository.recordSuccess();
  assert.equal(healthy.runtime.authenticationStatus, "healthy");
  assert.equal(healthy.runtime.circuitOpen, false);

  console.log(
    "PASS inventory publication settings persist circuit and authentication health",
  );
} finally {
  await inventoryPublicationSettingsRepository.save(
    DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
  );
  await inventoryPublicationSettingsRepository.resume();
  await getPool().end();
}
