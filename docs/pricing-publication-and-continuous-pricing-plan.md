# Pricing Publication and Continuous Pricing Plan

Status: Implementation complete; production rollout gated and disabled by default
Created: 2026-08-05
Scope: Pricing candidates, inventory deltas, Seller Portal publication, and continuous repricing

## Goal

Replace the CSV handoff with a durable publication pipeline that can safely:

1. Apply Inventory Manager quantity additions and calculated prices.
2. Apply price-only changes to existing seller inventory.
3. Preserve a complete audit trail and stop safely when a Seller Portal outcome is uncertain.
4. Evolve into a continuously running pricing service without coupling calculation to publication.

Automatic live publication and continuous scheduling remain disabled until explicitly enabled through the rollout controls in this plan.

## Decisions

These decisions are considered settled unless a controlled test disproves an endpoint assumption:

- Staged pricing import is the default batch publication mechanism.
- Inventory Manager quantities are signed deltas and are sent through `AddToQuantity`.
- Existing seller inventory repricing sends `AddToQuantity = 0`.
- The direct inventory endpoint is reserved for explicit absolute corrections and reconciliation.
- Pricing completion and publication completion are separate durable states.
- Seller Portal state-changing requests are never automatically replayed after an ambiguous response.
- Quantity deltas are consumed at most once.
- Continuous price-only work admits at most one outstanding candidate per SKU; the next eligible cycle uses the latest inventory projection.
- Continuous publishing uses micro-batches rather than one staged import per SKU.
- The web process does not own the long-term continuous scheduler.

## Baseline at Plan Creation

The active server pipeline is:

1. Freeze Inventory Manager, seller inventory, or CSV input into an inventory batch.
2. Create a database-backed pricing job with a configuration snapshot.
3. Lease the job to the in-process pricing worker.
4. Calculate prices sequentially and persist successful or manual-review results.
5. Mark pricing complete.
6. Download successful results as a CSV.

Useful foundations already present:

- Immutable batch inputs.
- Persisted pricing results.
- Database-backed job claiming with leases and heartbeats.
- Per-job pricing configuration snapshots.
- Successful and manual-review result separation.
- Seller Portal clients for staged delta updates and direct absolute updates.

Gaps that must be closed:

- No durable publication job, item state, or audit record.
- Repricing a batch retains the original quantity delta.
- Successful pricing results with warnings are not distinguished for live publication.
- No maximum price movement, minimum meaningful change, or candidate-age policy.
- Stored minimum-price configuration is not currently passed into the server calculator.
- Signed negative deltas are normalized away by current batch import conversion.
- The pricing worker starts from web activity rather than a dedicated boot-time worker.
- Seller Portal authentication expiry does not pause and surface publication health.

## Implemented Architecture

The codebase now implements the planned separation between calculation, publication, and scheduling:

- Durable publication plans and item outcomes with leases, deduplication identities, and quantity-delta consumption.
- Staged Seller Portal micro-batch publication with signed `AddToQuantity`, single-attempt state changes, rollback, and ambiguous-outcome stops.
- Direct absolute inventory updates retained for explicit reconciliation rather than routine pricing.
- Manual preview/publish and source-specific automatic publication policies, all disabled by default.
- Persisted authentication health, global pause, circuit breaker, queue health, and per-SKU publication history.
- A seller inventory projection with configurable refresh, minimum cadence, due-SKU claiming, and per-SKU pause/resume.
- Dedicated pricing, publication, and continuous-scheduler process bundles with production Compose services.
- Automatic pricing completion can plan publication without coupling Seller Portal success back into pricing success.
- CSV export remains available as the operational fallback.

Migrations 014 through 016 hold the durable state. Production enablement is an operational rollout decision, not a schema or code dependency.

## Safety Invariants

Every implementation and test must preserve these invariants:

### Quantity

- A source inventory delta has one stable identity.
- A non-zero delta can have only one durable publication item.
- A published or ambiguous delta cannot be placed in another automatic publication.
- Repricing a previously published batch produces a price-only candidate.
- Direct absolute updates require a quantity observation made immediately before the update.
- A quantity read followed by a direct write is not treated as atomic; it remains a reconciliation tool.

### Price

- Prices are rounded to cents before eligibility comparison and persistence.
- Missing, non-finite, zero, or negative prices are never published.
- Unchanged prices are not published.
- Excessive upward or downward movement requires manual review.
- Stale candidates are not published automatically.
- A newer price-only candidate may supersede an older unpublished price-only candidate.

### Delivery

- Pricing calculation never calls the Seller Portal directly.
- Pricing results are committed before publication work is queued.
- A publication failure never causes pricing to run again.
- State-changing Seller Portal requests are single-attempt.
- A lost or malformed move-to-live response produces `ambiguous`, not an automatic retry.
- Only an explicit reconciliation decision can move an ambiguous publication forward.

## Target Flow

```text
Inventory source
  -> pricing job
  -> persisted pricing result
  -> publication eligibility decision
       -> manual review
       -> durable publication item
  -> staged publication micro-batch
  -> move to live
  -> published / ambiguous / failed
  -> reconciliation and audit
```

## Publication Domain

### Publication statuses

- `planned`: Items are fixed and waiting for a worker.
- `staging`: The worker is initializing or uploading the staged import.
- `staged`: Upload and finalize were confirmed.
- `publishing`: Move-to-live was started.
- `published`: Move-to-live was confirmed and item effects were recorded.
- `ambiguous`: The request may have taken effect but confirmation was not reliable.
- `failed`: A confirmed failure occurred before a potentially successful move.
- `rolled_back`: A staged upload was explicitly removed before move-to-live.

### Publication item statuses

- `planned`
- `manual_review`
- `superseded`
- `published`
- `ambiguous`
- `failed`

### Required publication fields

- Publication ID
- Method (`staged_delta` or `direct_absolute`)
- Source type and source identifier
- Pricing job ID and configuration snapshot/version
- Seller key when applicable
- Staged upload ID
- Status and status timestamps
- Attempt count and worker lease
- Error classification and sanitized response metadata
- Created, updated, and published timestamps

### Required item fields

- Publication item ID
- Publication ID
- Stable candidate key
- Stable inventory-delta key when quantity delta is non-zero
- Batch number and SKU
- Product ID and display metadata required by the Seller Portal form
- Previous price and desired price
- Quantity delta
- Optional observed and desired absolute quantities for reconciliation
- Pricing result timestamp
- Eligibility decision and reason codes
- Item status and timestamps

## Persistence Design

Introduce:

### `inventory_publications`

- Identity primary key.
- Optional batch and pricing-job foreign keys.
- Method and status checks.
- Optional staged upload ID.
- Seller key.
- Configuration JSON snapshot.
- Progress and error JSON.
- Worker lease fields matching the existing pricing-job pattern.
- Created, updated, staged, publishing, published, and completed timestamps.

Indexes:

- Status plus creation time for worker claims.
- Lease expiry for recovery.
- Batch number and pricing job ID for UI lookup.
- Staged upload ID for reconciliation.

### `inventory_publication_items`

- Identity primary key.
- Publication foreign key with cascade delete only before execution.
- Stable candidate key with a unique constraint.
- Optional stable inventory-delta key with a unique partial index.
- SKU, product ID, price, quantity delta, metadata, decision, and status.
- Previous price and observed quantity for audit.
- Created, updated, and published timestamps.

Indexes:

- Publication ID and status.
- SKU and created time.
- Unique candidate key.
- Unique non-null inventory-delta key.

Published and ambiguous records are retained. Deletion of an executed publication is not supported by the application.

## Candidate Identity

Price candidate identity:

```text
pricing-result:{batchNumber}:{sku}:{pricedAt}
```

Inventory delta identity:

```text
inventory-batch-item:{batchNumber}:{sku}
```

Continuous pricing will use an immutable pricing candidate ID rather than a batch timestamp. These keys are local deduplication controls; they are not sent to TCGplayer.

## Source Policies

### Inventory Manager

- Default publication method: staged delta.
- Desired price: calculated marketplace price.
- Quantity delta: the user-entered batch quantity.
- Automatic publication can be enabled after manual staged publication is proven.
- After confirmed publication, the source delta is consumed.

### Seller inventory

- Default publication method: staged delta with zero delta.
- Desired price: calculated marketplace price.
- Quantity delta: zero.
- Current seller price is used for change thresholds.
- Custom listings remain excluded.

### CSV

- Automatic publication defaults off.
- Price-only publication may be explicitly enabled for trusted CSV inputs.
- Non-zero CSV quantity deltas require explicit review until signed-delta import behavior is fully represented by the batch model.

### Direct absolute correction

- Always explicit or reconciliation-driven.
- Refresh the seller quantity immediately before posting.
- Compute `absoluteQuantity = observedQuantity + requestedDelta` when adapting a delta.
- Persist the observation timestamp and desired absolute value.

## Eligibility Policy

The policy is a pure domain decision with stable reason codes.

Initial configuration:

- Automatic publishing: disabled.
- Automatic source policies: all disabled.
- Allow warning-bearing candidates: false.
- Maximum candidate age: 60 minutes.
- Minimum absolute price change: $0.01.
- Minimum relative price change: 0%.
- Maximum automatic decrease: 25%.
- Maximum automatic increase: 100%.
- Staged micro-batch maximum: 250 items.
- Staged flush window: 60 seconds.

Reason codes include:

- `automatic_publishing_disabled`
- `source_not_enabled`
- `pricing_error`
- `pricing_warning`
- `missing_price`
- `invalid_price`
- `missing_previous_price`
- `unchanged_price`
- `below_minimum_change`
- `decrease_limit_exceeded`
- `increase_limit_exceeded`
- `candidate_stale`
- `inventory_delta_already_consumed`
- `older_price_candidate_superseded`

Policies are stored with server pricing configuration only after normalization, persistence, and UI support are implemented together.

## Staged Publication Workflow

1. Claim one planned publication with a database lease.
2. Validate that every item remains eligible and its quantity delta is unconsumed.
3. Initialize a staged pricing import and persist its upload ID immediately.
4. Upload chunks no larger than the endpoint limit.
5. Finalize with the confirmed successful product count.
6. Persist `staged`.
7. Persist `publishing` before move-to-live.
8. Call move-to-live once.
9. Validate response items and persist per-item outcomes.
10. Mark confirmed items and their quantity deltas published.
11. Mark uncertain transport or response outcomes ambiguous.

If initialization, upload, or finalization has a confirmed failure, attempt rollback and record both the original failure and rollback result.

## Ambiguous Outcome Reconciliation

Before automatic publication is enabled, add a read capability for staged-import status/history if the Seller Portal exposes one.

Reconciliation order:

1. Determine whether the staged upload still exists.
2. Inspect any Seller Portal import history or result state.
3. Refresh affected seller SKUs.
4. Compare price, observed quantity, expected delta, elapsed time, and possible sales.
5. Resolve as published, failed-safe-to-retry, or manual intervention required.

Quantity differences alone are not definitive because sales can occur concurrently.

## Worker Architecture

### Near term

Reuse the existing database lease pattern for a separate publication worker. It may initially run in the application process for manual testing, but it must have its own state and queue.

### Continuous operation

Run dedicated services from the same application image:

- `web`: React Router application and APIs.
- `pricing-worker`: Claims and calculates pricing work.
- `publication-worker`: Serializes Seller Portal publication.
- `pricing-scheduler`: Discovers due inventory and creates pricing work.

All coordination is through PostgreSQL leases and durable state. Restarting any process must not lose work.

## Continuous Pricing Model

Introduce an active seller inventory projection keyed by seller and SKU:

- Last observed quantity and price
- Product metadata
- Last inventory refresh time
- Last priced time
- Last published price and time
- Next price time
- Current pricing candidate ID
- Pause/manual-review reason

The scheduler selects the oldest due eligible SKUs with `FOR UPDATE SKIP LOCKED`.

Cadence is configurable by product line and may later use inventory value or sales velocity. Initial behavior should use a fixed minimum interval.

Pricing calculation should expose a single-SKU operation or item callback so each completed candidate can be persisted independently. Publication remains asynchronous.

The scheduler coalesces price-only work by admitting at most one outstanding candidate per SKU. While that candidate is planned, queued, processing, or ambiguous, no newer candidate is created. After a confirmed outcome, the next eligible cycle prices the latest inventory projection. Quantity deltas are never coalesced or recreated.

## Authentication and Circuit Breaking

- Detect login redirects, unauthorized responses, and missing expected JSON shapes.
- Pause publication globally when authentication is invalid.
- Surface an application health state requiring cookie refresh.
- Do not count authentication failures as item failures.
- Pause after a configurable number of consecutive Seller Portal failures.
- Require an explicit resume after authentication or circuit-breaker recovery.

## Observability

Expose:

- Queue depth by publication status.
- Oldest planned candidate age.
- Current staged upload ID.
- Published, failed, ambiguous, superseded, and manual-review counts.
- Seller Portal request latency and failure classification.
- Last successful publication time.
- Authentication health.
- Per-SKU publication history.

Logs must include publication ID, item ID, SKU, upload ID, and worker ID, but never authentication cookies.

## UI

Milestone UI:

1. Publication preview showing price changes, deltas, warnings, and exclusions.
2. `Publish successful rows` action.
3. Separate pricing and publication status chips.
4. Publication result and ambiguous-outcome panel.
5. Automatic publication settings per source.
6. Global pause/resume and authentication health.
7. Continuous-pricing schedule and per-SKU history.

CSV download remains available as a fallback throughout rollout.

## Testing

### Domain tests

- Eligibility reason precedence.
- Price rounding and thresholds.
- Candidate and inventory-delta identity.
- Source-to-publication-method selection.
- Delta consumption and candidate supersession.

### Repository tests

- Unique candidate and delta constraints.
- Publication claim concurrency.
- Lease expiry recovery.
- Valid state transitions.
- Published and ambiguous records cannot be recreated.

### Client contract tests

- Exact staged forms and chunk limits.
- Exact direct absolute form.
- No automatic retries for staged state changes.
- Response shape validation.

### Service tests

- Successful staged workflow.
- Confirmed upload failure and rollback.
- Finalize failure and rollback.
- Move-to-live success with partial item errors.
- Lost move response produces ambiguous without replay.
- Repricing a published batch emits a zero quantity delta.
- Newer price-only candidate supersedes older planned work.

### Controlled live tests

- Price-only staged update with delta zero.
- Positive quantity delta against changing live quantity.
- Authentication expiry behavior.
- Staged upload rollback.
- Lost-response reconciliation where safely reproducible.

## Rollout and Rollback

1. Ship schema and read-only publication preview.
2. Enable manual staged publishing for selected test batches.
3. Verify audit history and delta consumption.
4. Enable automatic Inventory Manager publication behind a disabled-by-default setting.
5. Enable seller price-only automatic publication.
6. Keep CSV automatic publication disabled until explicitly approved.
7. Deploy dedicated workers.
8. Enable continuous scheduling for a small allowlist.
9. Expand cadence gradually while monitoring ambiguous and manual-review rates.

Rollback is performed by pausing publication workers. Pricing and CSV generation continue independently. Published Seller Portal changes are not automatically reversed.

## Delivery Milestones

### Milestone 0 — Endpoint capability

- [x] Seller Portal domain/client configuration.
- [x] Direct absolute price and quantity update client.
- [x] Staged pricing import client with signed deltas.
- [x] Single-attempt staged state changes.

### Milestone 1 — Pricing safety foundation

- [x] Pass stored minimum-price settings into server pricing calculation.
- [x] Add a pure publication eligibility policy with stable reason codes.
- [x] Add domain tests for thresholds, warnings, age, and source policy.
- [x] Keep automatic publishing disabled by default.

Acceptance:

- Server pricing jobs honor their persisted configuration snapshot.
- Every candidate receives a deterministic eligible/manual-review decision.
- No live publication occurs.

### Milestone 2 — Durable publication persistence

- [x] Add publication and publication-item migrations.
- [x] Add repository types, state transitions, leases, and constraints.
- [x] Add candidate and inventory-delta identity.
- [x] Add repository tests.

Acceptance:

- Repeated planning cannot duplicate a candidate or quantity delta.
- Restarting the process preserves all publication work.

### Milestone 3 — Manual staged publication

- [x] Build staged updates from persisted successful results.
- [x] Add publication worker and rollback behavior.
- [x] Add preview and explicit publish action.
- [x] Persist item outcomes and quantity-delta consumption.
- [x] Display published, failed, and ambiguous results.

Acceptance:

- A user can publish a batch without downloading a CSV.
- Repricing and republishing cannot add the original inventory twice.

### Milestone 4 — Automatic batch publication

- [x] Persist publication settings.
- [x] Add source-specific automatic policies.
- [x] Add authentication health and circuit breaker.
- [x] Add automatic planning after pricing result commit.

Acceptance:

- Enabled sources publish eligible results without user action.
- Failures pause safely and do not trigger pricing reruns or delta replay.

### Milestone 5 — Dedicated workers

- [x] Separate web, pricing worker, publication worker, and continuous scheduler commands.
- [x] Add worker services to production Docker Compose.
- [x] Start queue recovery on process boot.
- [x] Add worker health and queue metrics.

Acceptance:

- Queued work resumes after restart without a browser request.
- Web deployments do not interrupt durable work.

### Milestone 6 — Continuous pricing

- [x] Add seller inventory projection and scheduler configuration.
- [x] Add due-SKU claiming and independent candidate persistence.
- [x] Add per-SKU admission coalescing for price-only work.
- [x] Add staged micro-batches bounded by batch size and scheduler cadence.
- [x] Add cadence, pause, allowlist, and history UI.

Acceptance:

- Enabled inventory is repriced continuously within configured cadence.
- No SKU is repriced more often than its minimum interval.
- Quantity deltas remain independent of continuous price-only work.

## Open Verification Items

- Identify a Seller Portal staged-import status/history endpoint for ambiguity reconciliation.
- Monitor the delay between Seller Portal live state and the public seller-inventory snapshot.
- Determine whether finalized but unmoved imports expire automatically.
- Measure safe staged import size and cadence under normal production traffic.
- Confirm authentication-cookie lifetime and observable expiry response.

## Execution Log

- 2026-08-05: Controlled test confirmed staged `AddToQuantity` is applied against live quantity at move-to-live time.
- 2026-08-05: Direct absolute and staged delta clients added.
- 2026-08-05: Architecture review selected staged publication, durable publication state, and dedicated continuous workers.
- 2026-08-05: Milestone 1 execution started.
- 2026-08-05: Milestone 1 completed; type checking and the full test suite pass.
- 2026-08-05: Milestone 2 completed and migration 014 validated against the local development database.
- 2026-08-05: Milestone 3 completed with preview, manual publish, durable outcomes, and ambiguity-safe rollback.
- 2026-08-05: Milestone 4 completed with persisted source controls, automatic planning, authentication health, and circuit breaking.
- 2026-08-05: Milestone 5 completed with separately bundled pricing, publication, and scheduler processes in production Compose.
- 2026-08-05: Milestone 6 completed with the seller inventory projection, due-SKU scheduler, micro-batches, per-SKU controls, and publication history.
- 2026-08-05: Migrations 014 through 016 validated against the local PostgreSQL development database.
- 2026-08-05: Full type check, unit/route suite, repository integration tests, production build, worker bundle syntax checks, and Compose validation pass.
- 2026-08-05: Production Compose services started with migrations 014 through 016 applied; pricing, publication, and scheduler workers are healthy.
- 2026-08-05: Two controlled staged attempts rolled back before move-to-live after the Seller Portal rejected mismatched display metadata; no live price or quantity changed.
- 2026-08-05: Publication planning was corrected to preserve frozen catalog product names and normalized condition/printing labels, with regression coverage.
- 2026-08-05: Controlled publication 3 moved upload 16109624 live for ProductConditionId 9190499, changing Decidueye ex - 012/088 from $0.55 to $0.53 with AddToQuantity 0.
- 2026-08-05: Logged-in Seller Portal verification showed live price $0.53 and quantity 2. The public seller-inventory snapshot still showed $0.55 immediately afterward, establishing an external propagation/cache delay.
- 2026-08-05: Automatic publication for every source and continuous pricing remain disabled after the rollout.
- 2026-08-06: Manual publication gained exact SKU selection, a conservative 20-SKU price-only default, selection-specific durable identities, staged-size validation, and regression coverage.
- 2026-08-06: Batch 89 completed with 1,115 successful results and 95 manual-review results, but the one-hour candidate-age guard correctly excluded the batch after its long pricing run.
- 2026-08-06: A fresh batch 91 repriced 20 price-only canary SKUs from frozen batch-89 catalog metadata with zero errors, warnings, or inventory deltas; one unchanged price was excluded.
- 2026-08-06: Publication 4 moved staged upload 16124993 live for the remaining 19 SKUs with 19 published, 0 failed, 0 ambiguous, and total AddToQuantity 0.
- 2026-08-06: A fresh public seller-inventory snapshot matched all 19 desired prices and all 19 frozen quantities. Authentication remained healthy, the circuit remained closed, and every automatic publication source plus continuous pricing remained disabled.
