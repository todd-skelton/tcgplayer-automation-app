import { data } from "react-router";
import {
  continuousPricingRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { refreshContinuousPricingInventory } from "../services/continuousInventoryRefresh.server";
import { runContinuousPricingSchedulerCycle } from "../services/continuousPricingScheduler.server";
import { applyContinuousPricingPolicy } from "../services/continuousPolicyRepricing.server";

class Refused extends Error {}

// The continuous pricing work a server-drawn screen asks for: refreshing the seller's inventory
// from TCGplayer, a scheduler cycle, and repricing. Each answers with what it did, as numbers.
export async function action({ request }: { request: Request }) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST")
    return data({ error: "Method not allowed." }, { status: 405, headers });
  try {
    const payload = (await request.json()) as { intent?: unknown };
    const settings = (await inventoryPublicationSettingsRepository.get())
      .settings.continuousPricing;
    switch (payload.intent) {
      case "refresh": {
        if (!settings.sellerKey)
          throw new Refused("Save a seller key before refreshing inventory.");
        const count = await refreshContinuousPricingInventory(
          settings.sellerKey,
          settings.minimumIntervalMinutes,
        );
        return data({ count }, { headers });
      }
      case "run":
        return data({ cycle: await runContinuousPricingSchedulerCycle() }, { headers });
      case "apply_policy": {
        if (!settings.enabled || !settings.sellerKey)
          throw new Refused("Enable continuous pricing before repricing inventory.");
        const result = await applyContinuousPricingPolicy(settings);
        return data(
          {
            cached: result.cachedCount,
            batches: result.batchNumbers.length,
            remaining: result.refreshCount,
          },
          { headers },
        );
      }
      case "reprice_all": {
        if (!settings.enabled || !settings.sellerKey)
          throw new Refused("Enable continuous pricing before repricing inventory.");
        const count = await continuousPricingRepository.makeEligibleInventoryDue(
          settings.sellerKey,
        );
        return data(
          { count, cycle: await runContinuousPricingSchedulerCycle() },
          { headers },
        );
      }
      default:
        throw new Refused("Unsupported continuous pricing action.");
    }
  } catch (error) {
    return data(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof Refused ? 409 : 500, headers },
    );
  }
}
