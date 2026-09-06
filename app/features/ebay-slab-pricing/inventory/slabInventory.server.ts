import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "~/core/db/database.server";
import {
  identityConflicts,
  type StoredSlabIdentity,
} from "../identity/slabIdentity";
import { slabIdentityService } from "../identity/slabIdentities.server";
import {
  parseInventoryImport,
  sellerAccount,
  SlabInventoryError,
  type InventoryImport,
  type ListingSnapshot,
} from "./slabInventory";

export type InventoryRow = {
  id: string;
  seller: string;
  itemId: string;
  variationKey: string;
  snapshot: ListingSnapshot;
  source: InventoryImport["source"];
  state: ListingSnapshot["state"] | "missing";
  revision: number;
  identityId: string | null;
  identitySource: "certificate" | "manual" | null;
  identityNote: string | null;
  observedAt: Date;
};
type InventoryIdentity = Pick<
  StoredSlabIdentity,
  | "id"
  | "grader"
  | "certificateNumber"
  | "candidate"
  | "identity"
  | "status"
  | "reviewReasons"
  | "valuationGroupKey"
  | "revision"
>;
const COLUMNS = `id, seller, item_id AS "itemId", variation_key AS "variationKey", snapshot, source,
  state, revision, identity_id AS "identityId", identity_source AS "identitySource", identity_note AS "identityNote", observed_at AS "observedAt"`;

export async function inventoryRevision(seller: string): Promise<number> {
  return (
    (
      await queryOne<{ revision: number }>(
        "SELECT revision FROM slab_inventory_accounts WHERE seller = $1",
        [sellerAccount(seller)],
      )
    )?.revision ?? 0
  );
}

// Import performs no remote writes. The account revision fences concurrent/slow snapshots.
export async function reconcileInventory(
  raw: InventoryImport,
  expectedRevision: number,
) {
  const input = parseInventoryImport(raw);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new SlabInventoryError(
      "invalid-input",
      "Provide the inventory revision from before the import started.",
    );
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '15s'");
    await db.query(
      "INSERT INTO slab_inventory_accounts (seller) VALUES ($1) ON CONFLICT DO NOTHING",
      [input.seller],
    );
    const account = (
      await db.query<{ revision: number; observed_at: Date | null }>(
        "SELECT revision, observed_at FROM slab_inventory_accounts WHERE seller = $1 FOR UPDATE",
        [input.seller],
      )
    ).rows[0];
    if (
      account.revision !== expectedRevision ||
      (account.observed_at &&
        account.observed_at.getTime() > Date.parse(input.observedAt))
    )
      throw new SlabInventoryError(
        "conflict",
        "Inventory changed while this import was running. Start a new import.",
      );
    // A single bounded JSON recordset avoids a query per physical listing.
    const rows = input.listings.map((snapshot) => ({
      id: randomUUID(),
      item_id: snapshot.itemId,
      variation_key: snapshot.variationKey,
      snapshot,
    }));
    await db.query(
      `WITH incoming AS (
        SELECT raw.id, raw.item_id, raw.variation_key,
          CASE WHEN $3 = 'ebay' AND raw.snapshot->'reviewReasons' ? 'listing-details-required' AND previous.id IS NOT NULL
            THEN raw.snapshot || jsonb_build_object('certificate', previous.snapshot->'certificate',
              'expected', previous.snapshot->'expected', 'specifics', previous.snapshot->'specifics')
            ELSE raw.snapshot END AS snapshot
        FROM jsonb_to_recordset($2::jsonb) AS raw(id uuid, item_id text, variation_key text, snapshot jsonb)
        LEFT JOIN slab_inventory previous ON previous.seller = $1 AND previous.item_id = raw.item_id AND previous.variation_key = raw.variation_key
      )
      INSERT INTO slab_inventory (id, seller, item_id, variation_key, snapshot, source, state, observed_at, identity_id, identity_source)
      SELECT x.id, $1, x.item_id, x.variation_key, x.snapshot, $3, x.snapshot->>'state', $4, i.id,
        CASE WHEN i.id IS NOT NULL THEN 'certificate' END
      FROM incoming x
      LEFT JOIN slab_identities i ON i.grader = x.snapshot->'certificate'->>'grader'
        AND i.certificate_number = x.snapshot->'certificate'->>'certificateNumber'
      ON CONFLICT (seller, item_id, variation_key) DO UPDATE SET
        snapshot = EXCLUDED.snapshot, source = EXCLUDED.source, state = EXCLUDED.state, observed_at = EXCLUDED.observed_at,
        identity_id = CASE WHEN slab_inventory.identity_source = 'manual' THEN slab_inventory.identity_id ELSE EXCLUDED.identity_id END,
        identity_source = CASE WHEN slab_inventory.identity_source = 'manual' THEN 'manual' ELSE EXCLUDED.identity_source END,
        revision = slab_inventory.revision + CASE WHEN slab_inventory.snapshot IS DISTINCT FROM EXCLUDED.snapshot
          OR slab_inventory.state IS DISTINCT FROM EXCLUDED.state
          OR (slab_inventory.identity_source IS DISTINCT FROM 'manual' AND slab_inventory.identity_id IS DISTINCT FROM EXCLUDED.identity_id) THEN 1 ELSE 0 END,
        updated_at = clock_timestamp()`,
      [input.seller, JSON.stringify(rows), input.source, input.observedAt],
    );
    let missing = 0;
    if (input.completeActiveInventory) {
      // Absence establishes only that a listing is no longer in the active set, not why it ended.
      missing =
        (
          await db.query(
            `UPDATE slab_inventory s SET state = 'missing', revision = revision + 1,
        observed_at = $3, updated_at = clock_timestamp() WHERE seller = $1 AND state = 'active'
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(item_id text, variation_key text)
          WHERE x.item_id = s.item_id AND x.variation_key = s.variation_key)`,
            [input.seller, JSON.stringify(rows), input.observedAt],
          )
        ).rowCount ?? 0;
    }
    await db.query(
      "UPDATE slab_inventory_accounts SET revision = revision + 1, observed_at = $2, imported_at = clock_timestamp() WHERE seller = $1",
      [input.seller, input.observedAt],
    );
    return {
      imported: rows.length,
      missing,
      revision: account.revision + 1,
      complete: input.completeActiveInventory,
    };
  });
}

type InventoryReviewRow = InventoryRow & {
  identity: InventoryIdentity | null;
  duplicateCertificate: boolean;
};
const REVIEW_COLUMNS = `${COLUMNS},
    (SELECT jsonb_build_object('id', i.id, 'grader', i.grader, 'certificateNumber', i.certificate_number,
      'candidate', i.candidate, 'identity', i.identity, 'status', i.status, 'reviewReasons', i.review_reasons,
      'valuationGroupKey', i.valuation_group_key, 'revision', i.revision) FROM slab_identities i WHERE i.id = s.identity_id) AS identity,
    EXISTS (SELECT 1 FROM slab_inventory other WHERE other.seller = s.seller AND other.id <> s.id AND other.state = 'active'
      AND s.snapshot->'certificate' <> 'null'::jsonb AND other.snapshot->'certificate' = s.snapshot->'certificate') AS "duplicateCertificate"`;
function reviewInventoryRow(row: InventoryReviewRow) {
  return {
    ...row,
    url: `https://www.ebay.com/itm/${row.itemId}`,
    reviewReasons: [
      ...new Set([
        ...row.snapshot.reviewReasons,
        ...(row.duplicateCertificate
          ? ["certificate-used-by-another-active-listing"]
          : []),
        ...(row.identity?.reviewReasons ?? ["identity-required"]),
        ...identityConflicts(
          row.identity?.identity ?? row.identity?.candidate?.identity ?? null,
          row.snapshot.expected,
        ),
        ...(row.identity &&
        row.snapshot.certificate &&
        (row.identity.grader !== row.snapshot.certificate.grader ||
          row.identity.certificateNumber !==
            row.snapshot.certificate.certificateNumber)
          ? ["listing-certificate-conflicts-with-manual-identity"]
          : []),
      ]),
    ],
  };
}
export async function getInventoryListing(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new SlabInventoryError(
      "invalid-input",
      "Choose an inventory listing.",
    );
  const row = await queryOne<InventoryReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM slab_inventory s WHERE id=$1`,
    [id],
  );
  return row ? reviewInventoryRow(row) : null;
}
export async function getInventory(seller: string, after = "", limit = 100) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (after && !/^[a-f0-9-]{36}$/.test(after))
  )
    throw new SlabInventoryError("invalid-input", "Invalid inventory page.");
  const rows = await query<InventoryReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM slab_inventory s WHERE seller=$1 AND ($2='' OR id>NULLIF($2,'')::uuid) ORDER BY id LIMIT $3`,
    [sellerAccount(seller), after, limit + 1],
  );
  const page = rows.slice(0, limit).map(reviewInventoryRow);
  return {
    items: page,
    next: rows.length > limit ? page.at(-1)!.id : null,
    revision: await inventoryRevision(seller),
  };
}

export async function resolveInventoryIdentity(
  seller: string,
  id: string,
  revision: number,
  signal?: AbortSignal,
) {
  const row = await queryOne<InventoryRow>(
    `SELECT ${COLUMNS} FROM slab_inventory WHERE seller = $1 AND id = $2`,
    [sellerAccount(seller), id],
  );
  if (!row || row.revision !== revision)
    throw new SlabInventoryError(
      "conflict",
      "Reload the listing before resolving its certificate.",
    );
  if (row.identitySource === "manual") return { identityId: row.identityId };
  if (!row.snapshot.certificate)
    throw new SlabInventoryError(
      "invalid-input",
      "Import a certificate or assign a reviewed identity to this listing.",
    );
  const result = await slabIdentityService.lookup(row.snapshot.certificate, {
    expected: row.snapshot.expected,
    signal,
  });
  const updated = await queryOne(
    `UPDATE slab_inventory SET identity_id = $4, identity_source = 'certificate',
    revision = revision + CASE WHEN identity_id IS DISTINCT FROM $4::uuid THEN 1 ELSE 0 END, updated_at = clock_timestamp()
    WHERE seller = $1 AND id = $2 AND revision = $3 RETURNING id`,
    [row.seller, id, revision, result.record.id],
  );
  if (!updated)
    throw new SlabInventoryError(
      "conflict",
      "Listing changed during certificate lookup. Reload it.",
    );
  return result;
}

export async function assignInventoryIdentity(
  seller: string,
  id: string,
  revision: number,
  identityId: string,
  note: string,
) {
  if (!note?.trim() || note.length > 1000)
    throw new SlabInventoryError(
      "invalid-input",
      "Record the reason for this listing identity correction.",
    );
  const updated = await queryOne(
    `UPDATE slab_inventory SET identity_id = $4, identity_source = 'manual', identity_note = $5,
    revision = revision + 1, updated_at = clock_timestamp() WHERE seller = $1 AND id = $2 AND revision = $3
    AND EXISTS (SELECT 1 FROM slab_identities WHERE id = $4 AND status = 'confirmed') RETURNING id`,
    [sellerAccount(seller), id, revision, identityId, note.trim()],
  );
  if (!updated)
    throw new SlabInventoryError(
      "conflict",
      "Reload the listing and choose a confirmed identity.",
    );
  return { ok: true };
}
