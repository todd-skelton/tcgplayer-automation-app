import { createHash } from "node:crypto";
import { query, withTransaction } from "~/core/db/database.server";
import { sellerAccount } from "../inventory/slabInventory";
import {
  parseSellerOutcomeCsv,
  SellerOutcomeError,
} from "./sellerOutcomeCsv.server";
import { reconcileSellerOutcomes, type SellerOutcome } from "./supplyContext";

export async function importSellerOutcomeCsv(csv: string, seller: string) {
  const rows = parseSellerOutcomeCsv(csv, seller);
  seller = rows[0].seller;
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '10s'");
    const now = (
      await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0].now;
    if (rows.some((row) => Date.parse(row.occurredAt) > now.getTime()))
      throw new SellerOutcomeError("An outcome cannot occur in the future.");
    const itemIds = [...new Set(rows.map((row) => row.itemId))];
    const owned = (
      await db.query<{ item_id: string }>(
        "SELECT DISTINCT item_id FROM slab_inventory WHERE seller=$1 AND item_id=ANY($2::text[])",
        [seller, itemIds],
      )
    ).rows;
    if (owned.length !== itemIds.length)
      throw new SellerOutcomeError(
        "Import each referenced listing into this seller's inventory first.",
      );
    const entries = rows.map((row) => ({
      event_id: row.id,
      item_id: row.itemId,
      payload: row,
      content_hash: createHash("sha256")
        .update(JSON.stringify(row))
        .digest("hex"),
    }));
    // Repeated imports retain first observation time. Contradictory claims remain visible for review.
    const result = await db.query(
      `INSERT INTO slab_seller_outcomes(seller,event_id,content_hash,item_id,payload)
      SELECT $1,x.event_id,x.content_hash,x.item_id,x.payload FROM jsonb_to_recordset($2::jsonb) AS x(event_id text,content_hash text,item_id text,payload jsonb)
      ON CONFLICT DO NOTHING`,
      [seller, JSON.stringify(entries)],
    );
    return { inserted: result.rowCount ?? 0, supplied: rows.length, itemIds };
  });
}
export async function readSellerOutcomes(
  seller: string,
  itemId: string,
  asOf = new Date().toISOString(),
) {
  seller = sellerAccount(seller);
  if (!/^\d{9,15}$/.test(itemId) || !Number.isFinite(Date.parse(asOf)))
    throw new SellerOutcomeError(
      "Choose one listing item ID and a valid observation time.",
    );
  // Include every claim for these event IDs so an incorrect-item correction cannot hide a conflict.
  const rows = await query<{
    payload: Omit<SellerOutcome, "observedAt">;
    observedAt: Date;
  }>(
    `SELECT payload,observed_at AS "observedAt" FROM slab_seller_outcomes WHERE seller=$1 AND observed_at<=$3
    AND event_id IN (SELECT event_id FROM slab_seller_outcomes WHERE seller=$1 AND item_id=$2 AND observed_at<=$3)
    ORDER BY observed_at,event_id,content_hash LIMIT 251`,
    [seller, itemId, asOf],
  );
  if (rows.length > 250)
    throw new SellerOutcomeError(
      "This listing has more than 250 outcome observations and needs a separate audit before evaluation.",
    );
  const outcomes: SellerOutcome[] = rows.map((row) => ({
    ...row.payload,
    observedAt: row.observedAt.toISOString(),
  }));
  const result = reconcileSellerOutcomes(outcomes, {
    seller,
    itemIds: new Set([itemId]),
    asOf,
  });
  return {
    seller,
    itemId,
    asOf,
    observations: outcomes,
    summary: {
      sales: result.sales,
      cancellations: result.cancellations,
      relists: result.relists,
      unresolved: result.unresolved,
      cancelledSaleIds: result.cancelledSaleIds,
      heldSaleIds: result.heldSaleIds,
    },
    source: "reviewed-manual" as const,
    completeOrderHistory: false as const,
    exposureValidated: false as const,
    saleProbability: null,
    expectedDaysToSell: null,
  };
}
export type SellerOutcomeReview = Awaited<
  ReturnType<typeof readSellerOutcomes>
>;
