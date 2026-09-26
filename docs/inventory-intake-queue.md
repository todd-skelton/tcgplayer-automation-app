# Inventory intake queue

Inventory Manager can queue pricing without leaving inventory entry. `Queue Pricing Only` is the primary action. `Queue Pricing & Publishing` explicitly authorizes publication of eligible rows from that handoff; it does not enable source-wide automatic publication. Timer-based batching and speculative pre-pricing are not part of this release.

## Handoff

- The browser waits for outstanding quantity edits. Entry is disabled only during the handoff or while its outcome is uncertain.
- The request records the displayed SKU quantities, seller, workflow, and optional cost in session storage before sending. Recovery reuses the same request and options, including after reload.
- Under the inventory advisory lock, the server compares the expected quantities with the entire saved queue. A changed queue returns a conflict, refreshes the displayed quantities, and requires a new explicit action. It cannot acquire publication permission or purchase cost through an older request.
- Batch creation, receipt links, entered/estimated cost, pricing job, and workflow intent commit in one database transaction. Repeated request IDs return the original batch without draining newer entries or rerunning costs.
- The publication seller must match the shipping/cost seller and is frozen in the intent. Pricing-only can run without a seller, but publication and entered cost cannot.
- Cost fields reset after a confirmed handoff. When splitting a purchase, enter only the portion belonging to that batch.

## Publication and recovery

The existing publication worker plans completed intake runs using database locks and the existing eligibility rules. Per-batch permission replaces the source auto-publish switch only for these explicit requests; global pause, authentication health, and the circuit breaker still apply. Pricing-only requests are excluded from source-wide automatic publication.

Planning all publication groups and updating the intent is atomic. A restart resumes unplanned work; transient planning errors retry after one minute, with three failed attempts moving the run to review. A failed or replaced pricing job, changed publication seller, or no eligible results requires review. Permission does not silently transfer to a replacement pricing job.

Marketplace writes stay in the existing publication state machine. Stable candidate/delta keys prevent duplicate quantity additions. Ambiguous outcomes are not replayed. The status panel shows the latest 25 handoffs and links to Batch Pricer for detailed errors and manual recovery.

## Verification

- `npm test` includes queue request validation, persistence/status tests, and isolated hook tests for the save barrier, original permission recovery, and failed edits.
- `npm run typecheck` and `npm run build` cover the application and worker bundles.
- `app/features/inventory-management/services/inventoryIntakeRuns.server.integration.test.ts` requires an isolated database named `inventory_intake_queue_test` with an optional alphanumeric suffix. Apply all migrations first and run with `npx tsx`. It deliberately injects database failures and never calls a marketplace write endpoint.

## Deployment and rollback

Pause publication before rolling out the web and workers together. Keep it paused until every service runs the new revision, to prevent an old pricing worker from applying source-wide automatic publication to a pricing-only handoff. Use the guarded `npm run prod:deploy` workflow; restore the prior pause state only after version and health checks.

For rollback, pause publication and keep it paused while running an older revision. Migration 050 is additive and can remain in place. Do not drop intake intents or resume old pricing workers against outstanding pricing-only jobs: older code does not recognize their permission. Deploy a forward fix or explicitly review and resolve those jobs first. Confirmed marketplace changes are never reversed automatically.
