import { queryOne, withTransaction } from "~/core/db/database.server";
import { getInventoryListing } from "../inventory/slabInventory.server";
import { getSlabRecommendation } from "../valuation/slabRecommendations.server";
import {
  buildPublicationPreview,
  previewConflicts,
  previewRequest,
  publicationId,
  SlabPublicationError,
  type PreviewRequest,
  type PublicationPreview,
} from "./slabPublicationPreview";

type StoredPreview = {
  id: string;
  request: PreviewRequest;
  plan: PublicationPreview;
};
async function describe(row: StoredPreview) {
  const [inventory, recommendation] = await Promise.all([
    getInventoryListing(row.plan.inventory.id),
    getSlabRecommendation(row.plan.recommendationId),
  ]);
  return {
    ...row,
    conflicts: previewConflicts(
      row.plan,
      inventory,
      recommendation,
      new Date().toISOString(),
    ),
    canPublish: false as const,
    publicationUnavailableReason:
      "A preview cannot publish directly. Prepare a live seller review and explicitly approve its separate publication intent.",
  };
}
export async function readPublicationPreview(input: {
  id?: string;
  inventoryId?: string;
}) {
  const id = input.id ?? input.inventoryId;
  if (!publicationId(id))
    throw new SlabPublicationError("Choose a saved preview or listing.");
  const row = await queryOne<StoredPreview>(
    input.id
      ? "SELECT id,request,plan FROM slab_publication_previews WHERE id=$1"
      : "SELECT id,request,plan FROM slab_publication_previews WHERE inventory_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [id],
  );
  return row ? describe(row) : null;
}
export async function preparePublicationPreview(input: PreviewRequest) {
  const request = previewRequest(input);
  const previous = await queryOne<StoredPreview>(
    "SELECT id,request,plan FROM slab_publication_previews WHERE id=$1",
    [request.intentId],
  );
  const matches = (saved: PreviewRequest) =>
    Object.entries(request).every(
      ([key, value]) => saved[key as keyof PreviewRequest] === value,
    );
  if (previous) {
    if (!matches(previous.request))
      throw new SlabPublicationError(
        "This preview intent was already used for a different selection.",
      );
    return describe(previous);
  }
  const [inventory, recommendation] = await Promise.all([
    getInventoryListing(request.inventoryId),
    getSlabRecommendation(request.recommendationId),
  ]);
  if (!inventory || !recommendation)
    throw new SlabPublicationError(
      "The listing or recommendation no longer exists.",
    );
  const plan = buildPublicationPreview(
    request,
    inventory,
    recommendation,
    new Date().toISOString(),
  );
  const json = JSON.stringify(plan);
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new SlabPublicationError(
      "This listing exceeds the saved preview size limit.",
    );
  const row = await withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '10s'");
    // Immutable intent IDs coalesce retry/double-click requests. Never replace a reviewed plan.
    const result = await db.query<StoredPreview>(
      `INSERT INTO slab_publication_previews(id,inventory_id,recommendation_id,request,plan,expires_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING id,request,plan`,
      [
        request.intentId,
        inventory.id,
        recommendation.id,
        JSON.stringify(request),
        json,
        plan.expiresAt,
      ],
    );
    await db.query(
      "DELETE FROM slab_publication_previews WHERE id IN (SELECT p.id FROM slab_publication_previews p WHERE expires_at<clock_timestamp()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM slab_publications s WHERE s.preview_id=p.id) ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)",
    );
    return result.rows[0];
  });
  if (!matches(row.request))
    throw new SlabPublicationError(
      "This preview intent was already used for a different selection.",
    );
  return describe(row);
}
export type SlabPublicationPreview = NonNullable<
  Awaited<ReturnType<typeof readPublicationPreview>>
>;
