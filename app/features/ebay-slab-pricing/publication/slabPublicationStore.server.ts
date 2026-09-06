import { randomUUID } from "node:crypto";
import { queryOne, query, withTransaction } from "~/core/db/database.server";
import { publicationId, SlabPublicationError } from "./slabPublicationPreview";
import type {
  PublicationState,
  SellerListingState,
  SlabPublicationPlan,
} from "./slabPublication";
export type StoredPublication = {
  id: string;
  plan: SlabPublicationPlan;
  state: PublicationState;
  reason: string | null;
  attempts: number;
  writeStartedAt: Date | null;
  updatedAt: Date;
};
export type PublicationJob = StoredPublication & { leaseId: string };
const fields = `id,plan,state,reason,attempts,write_started_at AS "writeStartedAt",updated_at AS "updatedAt"`;
const checkId = (id: string) => {
  if (!publicationId(id))
    throw new SlabPublicationError("Choose a publication intent.");
};
export async function getPublication(id: string) {
  checkId(id);
  return queryOne<StoredPublication>(
    `SELECT ${fields} FROM slab_publications WHERE id=$1`,
    [id],
  );
}
export async function publicationHistory(previewId: string) {
  checkId(previewId);
  return query<{
    id: string;
    state: PublicationState;
    reason: string | null;
    mode: "live" | "dry-run";
    price: { amount: number; currency: string };
    createdAt: Date;
  }>(
    `SELECT id,state,reason,mode,plan->'price' AS price,created_at AS "createdAt" FROM slab_publications WHERE preview_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,
    [previewId],
  );
}
export async function publicationEvents(id: string) {
  checkId(id);
  return query<{
    sequence: string;
    state: PublicationState;
    reason: string | null;
    observation: SellerListingState | null;
    createdAt: Date;
  }>(
    `SELECT sequence,state,reason,observation,created_at AS "createdAt" FROM slab_publication_events WHERE publication_id=$1 ORDER BY sequence DESC LIMIT 50`,
    [id],
  );
}
export async function savePublication(id: string, plan: SlabPublicationPlan) {
  checkId(id);
  const json = JSON.stringify(plan);
  if (Buffer.byteLength(json) > 16 * 1024)
    throw new SlabPublicationError(
      "The publication plan exceeds its size limit.",
    );
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='10s'");
    const row = (
      await db.query<StoredPublication>(
        `INSERT INTO slab_publications(id,preview_id,restore_of,seller,item_id,variation_key,mode,plan,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared') ON CONFLICT(id) DO NOTHING RETURNING ${fields}`,
        [
          id,
          plan.previewId,
          plan.restoreOf,
          plan.target.seller,
          plan.target.itemId,
          plan.target.variationKey,
          plan.mode,
          json,
        ],
      )
    ).rows[0];
    if (row) {
      await db.query(
        "INSERT INTO slab_publication_events(publication_id,state) VALUES($1,'prepared')",
        [id],
      );
      return row;
    }
    const previous = (
      await db.query<StoredPublication>(
        `SELECT ${fields} FROM slab_publications WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (
      !previous ||
      previous.plan.previewId !== plan.previewId ||
      previous.plan.mode !== plan.mode ||
      previous.plan.publisherId !== plan.publisherId ||
      previous.plan.restoreOf !== plan.restoreOf
    )
      throw new SlabPublicationError(
        "This intent already belongs to a different publication plan.",
      );
    return previous;
  });
}
export async function approvePublicationRow(id: string) {
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='10s'");
    const row = (
      await db.query<StoredPublication>(
        `UPDATE slab_publications SET state='approved',updated_at=clock_timestamp() WHERE id=$1 AND state='prepared' AND (plan->>'expiresAt')::timestamptz>clock_timestamp() RETURNING ${fields}`,
        [id],
      )
    ).rows[0];
    if (row)
      await db.query(
        "INSERT INTO slab_publication_events(publication_id,state) VALUES($1,'approved')",
        [id],
      );
    return !!row;
  });
}
export async function cancelPublication(id: string) {
  checkId(id);
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='10s'");
    const row = (
      await db.query(
        `UPDATE slab_publications SET state='cancelled',reason='operator-cancelled',lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND state IN ('prepared','approved','checking') RETURNING id`,
        [id],
      )
    ).rows[0];
    if (row)
      await db.query(
        "INSERT INTO slab_publication_events(publication_id,state,reason) VALUES($1,'cancelled','operator-cancelled')",
        [id],
      );
    return !!row;
  });
}
export async function claimPublication(
  id: string,
): Promise<PublicationJob | null> {
  checkId(id);
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='10s'");
    const row = (
      await db.query<PublicationJob>(
        `UPDATE slab_publications SET state=CASE WHEN state IN ('writing','reconcile') THEN 'reconcile' ELSE 'checking' END,
      attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND (attempts<20 OR state IN ('writing','reconcile')) AND (state='approved' OR (state IN ('checking','writing','reconcile') AND (lease_until IS NULL OR lease_until<=clock_timestamp())))
      RETURNING ${fields},lease_id AS "leaseId"`,
        [id, randomUUID()],
      )
    ).rows[0];
    if (row)
      await db.query(
        "INSERT INTO slab_publication_events(publication_id,state,reason) VALUES($1,$2,'execution-claimed')",
        [id, row.state],
      );
    return row ?? null;
  });
}
export async function finishPublication(
  job: PublicationJob,
  state: PublicationState,
  reason: string | null,
  observation: SellerListingState | null = null,
) {
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='10s'");
    const row = (
      await db.query<StoredPublication>(
        `UPDATE slab_publications SET state=$3,reason=$4,updated_at=clock_timestamp(),
      write_started_at=CASE WHEN $3='writing' THEN clock_timestamp() ELSE write_started_at END,
      lease_id=CASE WHEN $3='writing' THEN lease_id ELSE NULL END,lease_until=CASE WHEN $3='writing' THEN lease_until ELSE NULL END
      WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND state IN ('checking','writing','reconcile')
      AND ((state='checking' AND $3 IN ('writing','conflict','failed','dry-run')) OR (state='writing' AND $3 IN ('reconcile','confirmed','failed')) OR (state='reconcile' AND $3 IN ('reconcile','confirmed')))
      AND ($3<>'writing' OR (state='checking' AND mode='live' AND (plan->>'expiresAt')::timestamptz>clock_timestamp()))
      AND ($3<>'confirmed' OR (state IN ('writing','reconcile') AND mode='live'))
      AND ($3<>'dry-run' OR (state='checking' AND mode='dry-run')) RETURNING ${fields}`,
        [job.id, job.leaseId, state, reason],
      )
    ).rows[0];
    if (!row) return null;
    await db.query(
      "INSERT INTO slab_publication_events(publication_id,state,reason,observation) VALUES($1,$2,$3,$4)",
      [job.id, state, reason, observation ? JSON.stringify(observation) : null],
    );
    return row;
  });
}
