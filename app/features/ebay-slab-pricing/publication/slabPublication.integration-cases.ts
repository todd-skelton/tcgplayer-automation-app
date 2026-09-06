import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SlabPublicationPreview } from "./slabPublicationPreviews.server";
import {
  prepareSlabPublication,
  approveSlabPublication,
  runSlabPublication,
  runSlabPublicationBatch,
  dryRunSlabPublication,
} from "./slabPublicationExecution.server";
import {
  getPublication,
  publicationEvents,
  cancelPublication,
  claimPublication,
  finishPublication,
} from "./slabPublicationStore.server";
import {
  SlabPublisherError,
  type SellerListingState,
  type SlabPricePublisher,
} from "./slabPublication";
import { action } from "../routes/api.slab-publications.server";
import {
  getInventoryListing,
  reconcileInventory,
  inventoryRevision,
} from "../inventory/slabInventory.server";
import {
  calculateSlabRecommendation,
  overrideSlabPrice,
} from "../valuation/slabRecommendations.server";
import { preparePublicationPreview } from "./slabPublicationPreviews.server";

// Called within the workspace suite's disposable schema; all seller I/O below is synthetic.
export async function verifyPublicationExecution(
  preview: SlabPublicationPreview,
  db: pg.Pool,
) {
  const p = preview.plan,
    i = p.inventory;
  const base: SellerListingState = {
    seller: i.seller,
    accountSeller: i.seller,
    itemId: i.itemId,
    variationKey: i.variationKey,
    price: p.oldPrice,
    quantity: 1,
    state: "active",
    format: "fixed-price",
    certificate: i.snapshot.certificate!,
    title: i.snapshot.title,
    shipping: i.snapshot.shipping,
    protectedRevision: "a".repeat(64),
    observedAt: new Date().toISOString(),
    supported: true,
  };
  let current = structuredClone(base),
    writes = 0,
    reads = 0,
    readError = false;
  let behavior:
      | "accepted"
      | "rejected"
      | "unknown"
      | "lost"
      | "settings-changed"
      | "expired-readback" = "accepted",
    hold: (() => Promise<void>) | null = null;
  const provider: SlabPricePublisher = {
    id: "offline-contract-fixture",
    kind: "seller-api",
    async read() {
      reads++;
      if (hold) await hold();
      if (readError) throw new SlabPublisherError("reconnect-required");
      return {
        ...structuredClone(current),
        observedAt: new Date().toISOString(),
      };
    },
    async write(input) {
      writes++;
      assert.deepEqual(
        Object.keys(input).sort(),
        ["intentId", "itemId", "price", "seller", "variationKey"].sort(),
      );
      if (
        ["accepted", "lost", "settings-changed", "expired-readback"].includes(
          behavior,
        )
      )
        current.price = { ...input.price };
      if (behavior === "lost") throw new Error("Lost fixture response");
      if (behavior === "settings-changed") {
        current.shipping = { ...current.shipping, amount: 5 };
        return "accepted";
      }
      if (behavior === "expired-readback") {
        readError = true;
        return "accepted";
      }
      return behavior;
    },
  };
  const reset = () => {
    current = structuredClone(base);
    writes = reads = 0;
    readError = false;
    behavior = "accepted";
    hold = null;
  };
  const prepare = () =>
    prepareSlabPublication(
      { intentId: randomUUID(), previewId: preview.id, mode: "live" },
      provider,
    );
  const ready = async () => {
    const row = await prepare();
    await approveSlabPublication(row.id, provider);
    return row;
  };
  reset();
  const first = await ready();
  assert.equal(
    (await runSlabPublication(first.id, provider)).state,
    "confirmed",
  );
  assert.equal(writes, 1);
  const readCount = reads;
  assert.equal(
    (await runSlabPublication(first.id, provider)).state,
    "confirmed",
  );
  assert.equal(writes, 1);
  assert.equal(reads, readCount);
  assert.deepEqual(
    (await publicationEvents(first.id)).map((r) => r.state).reverse(),
    ["prepared", "approved", "checking", "writing", "confirmed"],
  );
  reset();
  current.accountSeller = "other";
  await assert.rejects(prepare, /wrong-seller/);
  current = structuredClone(base);
  current.supported = false;
  await assert.rejects(prepare, /unsupported/);
  for (const patch of [
    { price: { amount: 101, currency: "USD" } },
    { quantity: 0 },
    { quantity: 2 },
    { state: "sold" },
    { state: "ended" },
    { accountSeller: "other" },
    { seller: "other" },
    { protectedRevision: "b".repeat(64) },
  ] as Array<Partial<SellerListingState>>) {
    reset();
    const row = await ready();
    current = { ...current, ...patch };
    assert.equal(
      (await runSlabPublication(row.id, provider)).state,
      "conflict",
    );
    assert.equal(writes, 0);
  }
  reset();
  const auth = await ready();
  readError = true;
  assert.equal((await runSlabPublication(auth.id, provider)).state, "failed");
  assert.equal(writes, 0);
  assert.match((await getPublication(auth.id))!.reason!, /reconnect-required/);
  reset();
  const rejected = await ready();
  behavior = "rejected";
  assert.equal(
    (await runSlabPublication(rejected.id, provider)).state,
    "failed",
  );
  assert.equal(writes, 1);
  reset();
  const lost = await ready();
  behavior = "lost";
  assert.equal(
    (await runSlabPublication(lost.id, provider)).state,
    "confirmed",
  );
  assert.equal(writes, 1);
  reset();
  const evidenceExpiry = (
    await db.query(
      "SELECT key,expires_at FROM slab_evidence_refreshes WHERE latest_revision=ANY($1::uuid[])",
      [p.evidence.map((e) => e.revisionId)],
    )
  ).rows;
  const expiredEvidence = await ready();
  await db.query(
    "UPDATE slab_evidence_refreshes SET expires_at=clock_timestamp()-interval '1 second' WHERE key=ANY($1::text[])",
    [evidenceExpiry.map((e) => e.key)],
  );
  assert.equal(
    (await runSlabPublication(expiredEvidence.id, provider)).state,
    "conflict",
  );
  assert.equal(writes, 0);
  for (const row of evidenceExpiry)
    await db.query(
      "UPDATE slab_evidence_refreshes SET expires_at=$2 WHERE key=$1",
      [row.key, row.expires_at],
    );
  for (const failure of ["settings-changed", "expired-readback"] as const) {
    reset();
    const row = await ready();
    behavior = failure;
    assert.equal(
      (await runSlabPublication(row.id, provider)).state,
      "reconcile",
    );
    assert.equal(writes, 1);
    readError = false;
    current.shipping = structuredClone(base.shipping);
    assert.equal(
      (await runSlabPublication(row.id, provider)).state,
      "confirmed",
    );
    assert.equal(writes, 1);
  }
  reset();
  const uncertain = await ready();
  behavior = "unknown";
  assert.equal(
    (await runSlabPublication(uncertain.id, provider)).state,
    "reconcile",
  );
  assert.equal(await cancelPublication(uncertain.id), false);
  assert.equal(
    (await runSlabPublication(uncertain.id, provider)).state,
    "reconcile",
  );
  assert.equal(
    writes,
    1,
    "Old-price readback never retries an ambiguous write",
  );
  const blocked = await prepare();
  await assert.rejects(
    () => approveSlabPublication(blocked.id, provider),
    /already owns/,
  );
  await cancelPublication(blocked.id);
  current.price = p.newPrice;
  assert.equal(
    (await runSlabPublication(uncertain.id, provider)).state,
    "confirmed",
  );
  assert.equal(writes, 1);
  reset();
  const cancelled = await ready();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => {
      release = r;
    }),
    reached = new Promise<void>((r) => {
      started = r;
    });
  hold = async () => {
    started();
    await waiting;
  };
  const running = runSlabPublication(cancelled.id, provider);
  await reached;
  assert.equal(
    (await runSlabPublication(cancelled.id, provider)).state,
    "checking",
  );
  assert.equal(await cancelPublication(cancelled.id), true);
  release();
  await running;
  assert.equal(writes, 0);
  assert.equal((await getPublication(cancelled.id))!.state, "cancelled");
  reset();
  const stale = await ready(),
    old = (await claimPublication(stale.id))!;
  await db.query(
    "UPDATE slab_publications SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [stale.id],
  );
  const replacement = (await claimPublication(stale.id))!;
  assert.equal(await finishPublication(old, "writing", null), null);
  await finishPublication(replacement, "conflict", "fixture-complete");
  reset();
  const crash = await ready(),
    job = (await claimPublication(crash.id))!;
  assert.ok(await finishPublication(job, "writing", "simulated-crash"));
  await db.query(
    "UPDATE slab_publications SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [crash.id],
  );
  assert.equal(
    (await runSlabPublication(crash.id, provider)).state,
    "reconcile",
  );
  assert.equal(writes, 0, "Restart after dispatch only reconciles");
  current.price = p.newPrice;
  assert.equal(
    (await runSlabPublication(crash.id, provider)).state,
    "confirmed",
  );
  reset();
  const dry = await dryRunSlabPublication({
    intentId: randomUUID(),
    previewId: preview.id,
  });
  assert.equal(dry.state, "dry-run");
  assert.equal(dry.writeStartedAt, null);
  assert.ok(
    (await publicationEvents(dry.id)).every((e) => e.state !== "writing"),
  );
  assert.equal(writes, 0);
  reset();
  const partial = await ready();
  behavior = "rejected";
  const batch = await runSlabPublicationBatch(
    [randomUUID(), partial.id],
    provider,
  );
  assert.ok(batch[0].error);
  assert.equal(batch[1].publication?.state, "failed");
  await assert.rejects(
    () =>
      runSlabPublicationBatch(
        Array.from({ length: 11 }, () => randomUUID()),
        provider,
      ),
    /one to ten/,
  );
  await assert.rejects(
    () =>
      prepareSlabPublication(
        {
          intentId: randomUUID(),
          previewId: preview.id,
          mode: "live",
          restoreOf: first.id,
        },
        provider,
      ),
    /prior price/,
  );
  const response = await action({
    request: new Request("http://localhost/api/slab-publications", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ intent: "approve", id: first.id }),
    }),
  });
  assert.equal(response.init?.status, 503);
  const stored = (
    await db.query("SELECT snapshot FROM slab_inventory WHERE id=$1", [i.id])
  ).rows[0].snapshot;
  assert.equal(stored.price.amount, p.oldPrice.amount);
  // A restore is a new current preview, its own approval and its own readback, never a rollback of the first intent.
  reset();
  const liveInventory = (await getInventoryListing(i.id))!;
  await reconcileInventory(
    {
      seller: i.seller,
      source: "manual",
      completeActiveInventory: false,
      observedAt: new Date().toISOString(),
      listings: [{ ...liveInventory.snapshot, price: p.newPrice }],
    },
    await inventoryRevision(i.seller),
  );
  const updated = (await getInventoryListing(i.id))!;
  const restoredRecommendation = await calculateSlabRecommendation({
    slabId: p.identity.slabId,
    identityRevision: p.identity.revision,
    revisionIds: p.evidence.map((e) => e.revisionId),
    policy: p.policy,
    seller: { ...p.sellerConstraints, currentAsk: p.newPrice.amount },
  });
  const reviewed = (await overrideSlabPrice({
    recommendationId: restoredRecommendation.id,
    itemPrice: p.oldPrice.amount,
    currency: "USD",
    note: "Explicit synthetic restore to the prior price",
  }))!;
  const restorePreview = await preparePublicationPreview({
    intentId: randomUUID(),
    inventoryId: updated.id,
    inventoryRevision: updated.revision,
    recommendationId: reviewed.id,
    selection: "reviewed",
    overrideReviewedAt: reviewed.override!.reviewedAt,
  });
  current.price = p.newPrice;
  const restoration = await prepareSlabPublication(
    {
      intentId: randomUUID(),
      previewId: restorePreview.id,
      mode: "live",
      restoreOf: first.id,
    },
    provider,
  );
  assert.equal(
    (await runSlabPublication(restoration.id, provider)).state,
    "prepared",
    "Preparation never implies approval",
  );
  assert.equal(writes, 0);
  await approveSlabPublication(restoration.id, provider);
  assert.equal(
    (await runSlabPublication(restoration.id, provider)).state,
    "confirmed",
  );
  assert.equal(current.price.amount, p.oldPrice.amount);
  assert.equal(writes, 1);
  assert.equal(restoration.plan.restoreOf, first.id);
  assert.equal(
    (await getPublication(first.id))!.state,
    "confirmed",
    "Original outcome remains immutable",
  );
  console.log(
    "PASS durable publication approval, price-only writes, readback, ambiguity/restart recovery, fencing, cancellation, partial batches and disabled live HTTP",
  );
}
