import { randomUUID } from "node:crypto";
import { query, queryOne } from "~/core/db/database.server";
import { sellerAccount } from "../inventory/slabInventory";
import {
  defaultMaintenanceSettings,
  maintenanceSettings,
  SlabMaintenanceError,
  type MaintenanceSettings,
} from "./slabMaintenance";
type Summary = {
  checked: number;
  queued: number;
  requested: number;
  recalculated: number;
  held: number;
  waiting: number;
  refreshBudget: number;
};
export type StoredMaintenance = MaintenanceSettings & {
  nextCycleAt: Date;
  lastCycleAt: Date | null;
  lastError: string | null;
  lastSummary: Summary | null;
};
export type MaintenanceJob = StoredMaintenance & { leaseId: string };
const fields = `seller,enabled,include_supply AS "includeSupply",interval_minutes AS "intervalMinutes",batch_size AS "batchSize",refresh_budget AS "refreshBudget",revision,
  next_cycle_at AS "nextCycleAt",last_cycle_at AS "lastCycleAt",last_error AS "lastError",last_summary AS "lastSummary"`;
export async function getMaintenanceSettings(seller: string) {
  seller = sellerAccount(seller);
  return (
    (await queryOne<StoredMaintenance>(
      `SELECT ${fields} FROM slab_maintenance_settings WHERE seller=$1`,
      [seller],
    )) ?? {
      ...defaultMaintenanceSettings(seller),
      nextCycleAt: null,
      lastCycleAt: null,
      lastError: null,
      lastSummary: null,
    }
  );
}
export async function saveMaintenanceSettings(input: MaintenanceSettings) {
  const value = maintenanceSettings(input);
  const row = await queryOne<StoredMaintenance>(
    `INSERT INTO slab_maintenance_settings(seller,enabled,include_supply,interval_minutes,batch_size,refresh_budget)
    SELECT $1,$2,$3,$4,$5,$6 WHERE $7=0 ON CONFLICT(seller) DO NOTHING RETURNING ${fields}`,
    [
      value.seller,
      value.enabled,
      value.includeSupply,
      value.intervalMinutes,
      value.batchSize,
      value.refreshBudget,
      value.revision,
    ],
  );
  if (row) return row;
  const updated = await queryOne<StoredMaintenance>(
    `UPDATE slab_maintenance_settings SET enabled=$2,include_supply=$3,interval_minutes=$4,batch_size=$5,refresh_budget=$6,
    revision=revision+1,lease_id=NULL,lease_until=NULL,next_cycle_at=clock_timestamp(),last_error=NULL WHERE seller=$1 AND revision=$7 RETURNING ${fields}`,
    [
      value.seller,
      value.enabled,
      value.includeSupply,
      value.intervalMinutes,
      value.batchSize,
      value.refreshBudget,
      value.revision,
    ],
  );
  if (!updated)
    throw new SlabMaintenanceError(
      "Maintenance settings changed. Reload before saving.",
    );
  return updated;
}
export async function claimMaintenance(): Promise<MaintenanceJob | null> {
  return queryOne<MaintenanceJob>(
    `UPDATE slab_maintenance_settings SET lease_id=$1,lease_until=clock_timestamp()+interval '90 seconds'
    WHERE seller=(SELECT seller FROM slab_maintenance_settings WHERE enabled AND next_cycle_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY next_cycle_at,seller FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ${fields},lease_id AS "leaseId"`,
    [randomUUID()],
  );
}
export async function maintenanceActive(job: MaintenanceJob) {
  return !!(await queryOne(
    "SELECT 1 FROM slab_maintenance_settings WHERE seller=$1 AND enabled AND revision=$2 AND lease_id=$3 AND lease_until>clock_timestamp()",
    [job.seller, job.revision, job.leaseId],
  ));
}
export async function maintenanceCandidates(job: MaintenanceJob) {
  return query<{ id: string }>(
    `SELECT i.id FROM slab_inventory i LEFT JOIN slab_identities d ON d.id=i.identity_id LEFT JOIN slab_maintenance_items m ON m.inventory_id=i.id
  WHERE i.seller=$1 AND i.state='active' AND (m.inventory_id IS NULL OR m.inventory_revision<>i.revision OR m.identity_revision IS DISTINCT FROM d.revision OR m.settings_revision<>$2 OR m.next_check_at<=clock_timestamp()
    OR m.recommendation_id IS DISTINCT FROM (SELECT r.id FROM slab_recommendations r WHERE r.slab_id=i.identity_id ORDER BY r.created_at DESC,r.id DESC LIMIT 1))
  ORDER BY (m.inventory_id IS NULL OR m.inventory_revision<>i.revision OR m.identity_revision IS DISTINCT FROM d.revision) DESC,m.checked_at NULLS FIRST,i.id LIMIT $3`,
    [job.seller, job.revision, job.batchSize],
  );
}
export async function maintenanceCheckpoint(
  job: MaintenanceJob,
  input: {
    inventoryId: string;
    inventoryRevision: number;
    identityRevision: number | null;
    inputKey: string | null;
    recommendationId: string | null;
    outcome: string;
    reason: string;
    waiting: boolean;
  },
) {
  return query(
    `INSERT INTO slab_maintenance_items(inventory_id,inventory_revision,identity_revision,input_key,recommendation_id,outcome,reason,next_check_at,settings_revision)
    SELECT $1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 second',$9 WHERE EXISTS(SELECT 1 FROM slab_maintenance_settings WHERE seller=$10 AND enabled AND revision=$9 AND lease_id=$11 AND lease_until>clock_timestamp())
    ON CONFLICT(inventory_id) DO UPDATE SET inventory_revision=EXCLUDED.inventory_revision,identity_revision=EXCLUDED.identity_revision,input_key=EXCLUDED.input_key,
      recommendation_id=EXCLUDED.recommendation_id,outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,checked_at=clock_timestamp(),next_check_at=EXCLUDED.next_check_at,settings_revision=EXCLUDED.settings_revision`,
    [
      input.inventoryId,
      input.inventoryRevision,
      input.identityRevision,
      input.inputKey,
      input.recommendationId,
      input.outcome,
      input.reason,
      input.waiting ? 30 : job.intervalMinutes * 60,
      job.revision,
      job.seller,
      job.leaseId,
    ],
  );
}
export async function finishMaintenance(
  job: MaintenanceJob,
  summary: Summary,
  error: string | null = null,
) {
  await query(
    "UPDATE slab_maintenance_settings SET last_cycle_at=clock_timestamp(),last_error=$4,last_summary=$5,next_cycle_at=clock_timestamp()+interval '30 seconds',lease_id=NULL,lease_until=NULL WHERE seller=$1 AND revision=$2 AND lease_id=$3 AND lease_until>clock_timestamp()",
    [job.seller, job.revision, job.leaseId, error, JSON.stringify(summary)],
  );
}
export async function maintenanceItemState(inventoryId: string) {
  return queryOne<{ inputKey: string | null; recommendationId: string | null }>(
    `SELECT input_key AS "inputKey",recommendation_id AS "recommendationId" FROM slab_maintenance_items WHERE inventory_id=$1`,
    [inventoryId],
  );
}
export async function maintenanceOverview(seller: string) {
  return query<{
    id: string;
    title: string;
    outcome: string;
    reason: string;
    checkedAt: Date;
  }>(
    `SELECT i.id,i.snapshot->>'title' AS title,m.outcome,m.reason,m.checked_at AS "checkedAt" FROM slab_maintenance_items m JOIN slab_inventory i ON i.id=m.inventory_id WHERE i.seller=$1 ORDER BY m.checked_at DESC,i.id LIMIT 25`,
    [sellerAccount(seller)],
  );
}
