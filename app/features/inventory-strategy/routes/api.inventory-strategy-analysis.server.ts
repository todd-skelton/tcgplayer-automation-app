import { data } from "react-router";
import { inventoryPublicationSettingsRepository } from "~/core/db";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";

class Refused extends Error {}

// Queues a strategy analysis for the configured seller, as the server-drawn Inventory Strategy
// screen asks: the batch queued, or the one already queued or pricing, as numbers.
export async function action({ request }: { request: Request }) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST")
    return data({ error: "Method not allowed." }, { status: 405, headers });
  try {
    const sellerKey = (await inventoryPublicationSettingsRepository.get())
      .settings.continuousPricing.sellerKey;
    if (!sellerKey) throw new Refused("Configure a seller key first.");
    const { batch, created } = await queueInventoryStrategyAnalysis(sellerKey);
    return data(
      {
        batchNumber: batch.batchNumber,
        itemCount: batch.itemCount,
        status: batch.status,
        created,
      },
      { headers },
    );
  } catch (error) {
    return data(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof Refused ? 409 : 500, headers },
    );
  }
}
