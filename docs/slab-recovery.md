# Slab database recovery

Slab data lives in the existing PostgreSQL database. Back up the whole database with the matching PostgreSQL `pg_dump` custom format and verify it with `pg_restore --single-transaction --exit-on-error` into a separate, empty database. Preserve access controls for backups because production backups can contain seller/provider credentials. The verification command below uses synthetic data only and never copies the development or production database.

Before an actual backup or deployment, pause slab maintenance and stop its worker. Finish or record in-progress provider requests. Keep every publication with a possible write marked for reconciliation; stopping a worker does not prove that an external request failed. Back up after writers are stopped if the backup will serve as a rollback point.

Restore inventory, identities, comp decisions, evidence, supply scans/versions, recommendations, overrides, previews, publication events and maintenance together. The evidence cache has circular latest-revision references and supply/recommendation links; selected table or data-only restores need additional care and are not the supported procedure here. Apply migrations before starting the new application. Pause restored maintenance settings before starting workers: a backup faithfully restores enabled settings too. Increment the settings revision and clear its lease when pausing, as the application's settings save does.

Revalidate source connections and fresh inventory/evidence after recovery. For publications whose recorded write boundary was crossed, reconnect seller access and reconcile by reading the listing; never replay the write from the restored queue. A database restore cannot undo eBay changes. If eBay changes occurred after the backup, the restored audit can be incomplete: reconcile affected listings against current seller state and any newer audit backup before preparing another change. Native seller reconciliation remains blocked pending OAuth activation, so live publication is still unavailable.

Application rollback can leave additive slab tables in place. Pause maintenance before returning to an older application build. Do not drop the audit or referenced evidence as a rollback mechanism. Normal TCGplayer routes and workers use their existing tables and do not depend on the new slab tables.

## Reproducible local check

With the development PostgreSQL container `tcgplayer-postgres-db` mapped to localhost:5433/tcgplayer_automation, run:

```sh
node app/features/ebay-slab-pricing/evaluation/verify-slab-recovery.mjs
```

The command rejects other database targets, verifies the container port, creates three randomly named disposable databases and removes only those databases in `finally`. It runs the real migration command for a fresh installation, an upgrade from migration 23, and idempotent reruns. It uses PostgreSQL's native dump/restore programs in the existing development container, keeps the synthetic archive in memory, and adds no production dependency or service.

On September 6, 2026, against application commit `ec9146cda` and PostgreSQL 16.13, the check passed all 33 migrations. The upgrade preserved every existing table's row checksum. A 114,452-byte custom archive restored identical counts and checksums for all 43 tables, including immutable evidence/supply references, a reviewed ask, an unresolved publication and enabled maintenance. Foreign keys continued to protect referenced evidence; the unresolved publication still prevented a second approved intent; its audit sequence resumed at 2. Pausing restored maintenance preserved the possible-write record.

These fixtures validate storage/recovery mechanics, not market evidence, live eBay behavior or a production-data restore. Existing service integration tests separately validate publication readback/recovery and maintenance leases. Production backup, deployment, native seller verification and full workflow acceptance remain part of #33.
