import { data } from "react-router";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { SlabPublicationError } from "../publication/slabPublicationPreview";
import { SlabPublisherError } from "../publication/slabPublication";
import { SlabInventoryError } from "../inventory/slabInventory";
import {
  dryRunSlabPublication,
  prepareSlabPublication,
  approveSlabPublication,
  runSlabPublication,
} from "../publication/slabPublicationExecution.server";
import {
  ebaySlabPublisher,
  sellerPublicationStatus,
} from "../publication/ebaySlabPublication.server";
import {
  getPublication,
  publicationEvents,
  publicationHistory,
  listingPublicationHistory,
  cancelPublication,
} from "../publication/slabPublicationStore.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof SlabPublisherError && error.code === "unsupported"
          ? "This listing type or origin is not supported by this publisher."
          : error instanceof SlabPublisherError ||
              error instanceof SlabInventoryError
            ? "Seller verification is unavailable. Check the connected seller and reconnect if needed."
            : error instanceof SlabPublicationError
              ? error.message
              : "Unable to access slab publication.",
    },
    error instanceof SlabPublisherError || error instanceof SlabInventoryError
      ? 503
      : error instanceof SlabPublicationError ||
          error instanceof SyntaxError ||
          error instanceof TypeError
        ? 400
        : 500,
  );
export async function loader({ request }: { request: Request }) {
  try {
    const params = new URL(request.url).searchParams,
      id = params.get("id");
    if (id)
      return respond({
        capabilities: sellerPublicationStatus(),
        publication: await getPublication(id),
        events: await publicationEvents(id),
      });
    if (params.has("inventoryId"))
      return respond({
        capabilities: sellerPublicationStatus(),
        publications: await listingPublicationHistory(
          params.get("inventoryId") ?? "",
        ),
      });
    return respond({
      publications: await publicationHistory(params.get("previewId") ?? ""),
    });
  } catch (error) {
    return failure(error);
  }
}
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return respond({ error: "Review publication from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 16384);
    if (input.intent === "cancel") {
      await cancelPublication(input.id);
      return respond(await getPublication(input.id));
    }
    if (input.intent !== "dry-run") {
      const capabilities = sellerPublicationStatus();
      if (!capabilities.sellerConfigured)
        return respond(
          {
            error:
              "Live seller publication is not connected. Only an imported-inventory dry run is available.",
          },
          503,
        );
      const provider = ebaySlabPublisher();
      if (input.intent === "prepare-live")
        return respond(
          await prepareSlabPublication(
            {
              intentId: input.intentId,
              previewId: input.previewId,
              restoreOf: input.restoreOf,
              mode: "live",
            },
            provider,
          ),
        );
      if (input.intent === "approve") {
        if (!capabilities.reviewedWritesEnabled)
          return respond(
            {
              error:
                "Reviewed publishing is disabled. No new price write can start.",
            },
            503,
          );
        if (input.confirmation !== input.id)
          throw new SlabPublicationError(
            "Review and explicitly approve this saved publication intent.",
          );
        await approveSlabPublication(input.id, provider);
        return respond(await runSlabPublication(input.id, provider));
      }
      if (input.intent === "reconcile") {
        const saved = await getPublication(input.id);
        if (!saved?.writeStartedAt)
          throw new SlabPublicationError(
            "This intent has no recorded write to reconcile. Review it before publishing.",
          );
        return respond(await runSlabPublication(input.id, provider));
      }
      throw new SlabPublicationError(
        "Choose prepare, approve, reconcile or cancel for the saved intent.",
      );
    }
    return respond(
      await dryRunSlabPublication({
        intentId: input.intentId,
        previewId: input.previewId,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
