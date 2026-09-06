import { createHash } from "node:crypto";
import { publicationRequest } from "./publicationRequest";
import { getInventoryListing } from "../inventory/slabInventory.server";
import { readPublicationPreview } from "./slabPublicationPreviews.server";
import { publicationId, SlabPublicationError } from "./slabPublicationPreview";
import {
  listingState,
  listingConflicts,
  preparePublicationPlan,
  SlabPublisherError,
  type SlabPricePublisher,
  type SlabPublicationPlan,
} from "./slabPublication";
import {
  getPublication,
  savePublication,
  approvePublicationRow,
  claimPublication,
  finishPublication,
  type PublicationJob,
} from "./slabPublicationStore.server";
const now = () => new Date().toISOString();
const providerError = (error: unknown) =>
  error instanceof SlabPublisherError ? error.code : "unavailable";
function providerMatches(
  plan: SlabPublicationPlan,
  provider: SlabPricePublisher,
) {
  return (
    plan.publisherId === provider.id &&
    (plan.mode === "live"
      ? provider.kind === "seller-api"
      : provider.kind === "imported-inventory")
  );
}
async function currentPlan(plan: SlabPublicationPlan) {
  if (
    plan.version !== "slab-publication-v1" ||
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    Date.parse(plan.createdAt) > Date.now() ||
    Date.parse(plan.expiresAt) <= Date.now()
  )
    return ["plan-expired"];
  const preview = await readPublicationPreview({ id: plan.previewId });
  return preview?.id === plan.previewId
    ? preview.conflicts
    : ["preview-unavailable"];
}
export async function prepareSlabPublication(
  input: {
    intentId: string;
    previewId: string;
    mode: "live" | "dry-run";
    restoreOf?: string;
  },
  provider: SlabPricePublisher,
) {
  if (
    !publicationId(input.intentId) ||
    !publicationId(input.previewId) ||
    !["live", "dry-run"].includes(input.mode) ||
    (input.restoreOf !== undefined && !publicationId(input.restoreOf))
  )
    throw new SlabPublicationError(
      "Provide a saved preview and a new publication intent.",
    );
  if (
    input.mode === "live"
      ? provider.kind !== "seller-api"
      : provider.kind !== "imported-inventory"
  )
    throw new SlabPublicationError(
      "This provider cannot verify the selected publication mode.",
    );
  const previous = await getPublication(input.intentId);
  if (previous) {
    if (
      previous.plan.previewId !== input.previewId ||
      previous.plan.mode !== input.mode ||
      previous.plan.publisherId !== provider.id ||
      previous.plan.restoreOf !== (input.restoreOf ?? null)
    )
      throw new SlabPublicationError(
        "This intent already belongs to another publication.",
      );
    return previous;
  }
  const preview = await readPublicationPreview({ id: input.previewId });
  if (!preview || preview.conflicts.length)
    throw new SlabPublicationError(
      "The preview changed or expired. Prepare a new review.",
    );
  const inventory = await getInventoryListing(preview.plan.inventory.id);
  if (!inventory?.identity || inventory.identity.status !== "confirmed")
    throw new SlabPublicationError(
      "Confirm the listing certificate before preparing publication.",
    );
  if (input.restoreOf) {
    const original = await getPublication(input.restoreOf);
    if (
      !original ||
      original.state !== "confirmed" ||
      input.mode !== "live" ||
      original.plan.target.seller !== preview.plan.inventory.seller ||
      original.plan.target.itemId !== preview.plan.inventory.itemId ||
      original.plan.target.variationKey !==
        preview.plan.inventory.variationKey ||
      original.plan.before.price.amount !== preview.plan.newPrice.amount ||
      original.plan.before.price.currency !== preview.plan.newPrice.currency
    )
      throw new SlabPublicationError(
        "Restore requires a fresh reviewed preview selecting this confirmed publication's prior price.",
      );
  }
  const target = {
    seller: inventory.seller,
    itemId: inventory.itemId,
    variationKey: inventory.variationKey,
  };
  const before = await publicationRequest((signal) =>
    provider.read(target, signal),
  );
  const plan = preparePublicationPlan({
    previewId: preview.id,
    preview: preview.plan,
    certificate: inventory.identity,
    before,
    publisherId: provider.id,
    mode: input.mode,
    restoreOf: input.restoreOf,
    now: now(),
  });
  if ((await currentPlan(plan)).length)
    throw new SlabPublicationError(
      "The review changed during the seller read. Prepare it again.",
    );
  return savePublication(input.intentId, plan);
}
export async function approveSlabPublication(
  id: string,
  provider: SlabPricePublisher,
) {
  const row = await getPublication(id);
  if (!row) throw new SlabPublicationError("Publication not found.");
  if (!providerMatches(row.plan, provider))
    throw new SlabPublicationError(
      "Reconnect the publication's original provider.",
    );
  if (row.state !== "prepared") return row;
  if ((await currentPlan(row.plan)).length)
    throw new SlabPublicationError(
      "The plan changed or expired. Prepare a new review before approving.",
    );
  try {
    await approvePublicationRow(id);
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new SlabPublicationError(
        "Another approved or unresolved publication already owns this listing.",
      );
    throw error;
  }
  return (await getPublication(id))!;
}
async function reconcile(job: PublicationJob, provider: SlabPricePublisher) {
  if (!job.writeStartedAt)
    return finishPublication(job, "reconcile", "write-boundary-unavailable");
  try {
    const observation = listingState(
      await publicationRequest((signal) =>
        provider.read(job.plan.target, signal),
      ),
    );
    const conflicts = listingConflicts(
      job.plan,
      observation,
      job.plan.price,
      now(),
      job.writeStartedAt?.toISOString(),
    );
    return await finishPublication(
      job,
      conflicts.length ? "reconcile" : "confirmed",
      conflicts.length
        ? `readback:${conflicts.join(",")}`
        : "price-and-protected-fields-confirmed",
      observation,
    );
  } catch (error) {
    return finishPublication(
      job,
      "reconcile",
      `readback:${providerError(error)}`,
    );
  }
}
export async function runSlabPublication(
  id: string,
  provider: SlabPricePublisher,
) {
  const saved = await getPublication(id);
  if (!saved) throw new SlabPublicationError("Publication not found.");
  if (!providerMatches(saved.plan, provider))
    throw new SlabPublicationError(
      "Reconnect the publication's original provider.",
    );
  const job = await claimPublication(id);
  if (!job) return (await getPublication(id))!;
  if (job.state === "reconcile") {
    await reconcile(job, provider);
    return (await getPublication(id))!;
  }
  let dispatched = false;
  try {
    const changed = await currentPlan(job.plan);
    if (changed.length) {
      await finishPublication(job, "conflict", changed.join(","));
      return (await getPublication(id))!;
    }
    const observation = listingState(
      await publicationRequest((signal) =>
        provider.read(job.plan.target, signal),
      ),
    );
    const conflicts = [
      ...listingConflicts(job.plan, observation, job.plan.before.price, now()),
      ...(await currentPlan(job.plan)),
    ];
    if (conflicts.length) {
      await finishPublication(
        job,
        "conflict",
        [...new Set(conflicts)].join(","),
        observation,
      );
      return (await getPublication(id))!;
    }
    if (job.plan.mode === "dry-run") {
      await finishPublication(
        job,
        "dry-run",
        "imported-inventory-checked-no-price-write",
        observation,
      );
      return (await getPublication(id))!;
    }
    // Commit the write boundary before dispatch. Recovery after this point may read, but never repeats the write.
    const writing = await finishPublication(
      job,
      "writing",
      "price-write-boundary-recorded",
      observation,
    );
    if (!writing) return (await getPublication(id))!;
    dispatched = true;
    let result: "accepted" | "rejected" | "unknown";
    try {
      result = await publicationRequest((signal) =>
        provider.write(
          { ...job.plan.target, intentId: job.id, price: job.plan.price },
          signal,
        ),
      );
    } catch {
      result = "unknown";
    }
    if (result === "rejected")
      await finishPublication(job, "failed", "provider-rejected-price-write");
    else
      await reconcile(
        { ...job, writeStartedAt: writing.writeStartedAt },
        provider,
      );
  } catch (error) {
    await finishPublication(
      job,
      dispatched ? "reconcile" : "failed",
      `${dispatched ? "write-outcome" : "preflight"}:${providerError(error)}`,
    );
  }
  return (await getPublication(id))!;
}
// Explicit, sequential batches bound requests and isolate outcomes. No scheduler runs this implicitly.
export async function runSlabPublicationBatch(
  ids: string[],
  provider: SlabPricePublisher,
) {
  if (
    !Array.isArray(ids) ||
    ids.length > 10 ||
    !ids.length ||
    ids.some((id) => !publicationId(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new SlabPublicationError(
      "Choose one to ten distinct publication intents.",
    );
  const results = [];
  for (const id of ids) {
    try {
      results.push({
        id,
        publication: await runSlabPublication(id, provider),
        error: null,
      });
    } catch {
      results.push({
        id,
        publication: null,
        error: "Publication unavailable; inspect the saved intent.",
      });
    }
  }
  return results;
}
function importedPublisher(inventoryId: string): SlabPricePublisher {
  return {
    id: "imported-inventory-dry-run",
    kind: "imported-inventory",
    async read() {
      const row = await getInventoryListing(inventoryId);
      if (!row?.identity) throw new SlabPublisherError("unavailable");
      const snapshot = row.snapshot;
      return {
        seller: row.seller,
        accountSeller: row.seller,
        itemId: row.itemId,
        variationKey: row.variationKey,
        price: snapshot.price,
        quantity: snapshot.quantity,
        state: row.state === "missing" ? "ended" : row.state,
        format: snapshot.format,
        certificate: row.identity,
        title: snapshot.title,
        shipping: snapshot.shipping,
        protectedRevision: createHash("sha256")
          .update(`${row.id}:${row.revision}`)
          .digest("hex"),
        observedAt: now(),
        supported: snapshot.format === "fixed-price" && !row.variationKey,
      };
    },
    async write() {
      throw new SlabPublicationError(
        "A dry-run provider can never write a price.",
      );
    },
  };
}
export async function dryRunSlabPublication(input: {
  intentId: string;
  previewId: string;
}) {
  const preview = await readPublicationPreview({ id: input.previewId });
  if (!preview) throw new SlabPublicationError("Preview not found.");
  const provider = importedPublisher(preview.plan.inventory.id);
  const saved = await prepareSlabPublication(
    { ...input, mode: "dry-run" },
    provider,
  );
  await approveSlabPublication(saved.id, provider);
  return runSlabPublication(saved.id, provider);
}
