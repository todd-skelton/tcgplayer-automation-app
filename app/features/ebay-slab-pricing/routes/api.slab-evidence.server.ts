import { data } from "react-router";
import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import {
  cancelEvidenceRefresh,
  evidenceStatuses,
  getEvidenceRevision,
  requestEvidence,
} from "../evidence/evidenceRefreshStore.server";
import { requestSlabEvidence } from "../evidence/slabEvidenceRefresh.server";
import { ensureEvidenceWorker } from "../evidence/evidenceRefreshWorker.server";
import { readSlabJsonRequest } from "../readJsonRequest.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  return respond(
    {
      error:
        error instanceof EvidenceRefreshError
          ? error.message
          : "Unable to access slab evidence.",
    },
    error instanceof EvidenceRefreshError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
      ? 400
      : 500,
  );
}
export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const revision = url.searchParams.get("revision");
    if (revision) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 2000)
        throw new EvidenceRefreshError("Invalid evidence page.");
      const record = await getEvidenceRevision(revision);
      if (!record)
        return respond(
          { error: "Evidence revision is no longer available." },
          404,
        );
      const payload = record.payload;
      if (payload.kind === "alt-sale-detail") return respond(record);
      const body = payload.data;
      const rows =
        "sales" in body
          ? body.sales
          : "listings" in body
            ? body.listings
            : undefined;
      if (!rows) return respond(record);
      const field = "sales" in body ? "sales" : "listings";
      return respond({
        ...record,
        payload: {
          ...payload,
          data: { ...body, [field]: rows.slice(offset, offset + 50) },
        },
        page: {
          offset,
          total: rows.length,
          nextOffset: offset + 50 < rows.length ? offset + 50 : null,
        },
      });
    }
    const statuses = await evidenceStatuses(
      (url.searchParams.get("keys") ?? "").split(",").filter(Boolean),
    );
    if (
      statuses.some((row) => row.state === "queued" || row.state === "running")
    )
      ensureEvidenceWorker();
    return respond({ statuses });
  } catch (error) {
    return failure(error);
  }
}
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return respond({ error: "Submit this request from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 16384);
    if (input.intent === "cancel")
      return respond({
        cancelled: await cancelEvidenceRefresh(input.key, input.runId),
      });
    if (input.intent === "refresh") {
      const result = await requestSlabEvidence(input.slabIds, input.window, {
        includeSupply: input.includeSupply === true,
        force: input.force === true,
      });
      ensureEvidenceWorker();
      return respond(result);
    }
    if (input.intent === "sale-detail") {
      const revision = await getEvidenceRevision(input.revision);
      if (
        revision?.payload.kind !== "alt-sales" ||
        !revision.payload.data.sales.some(
          (row) => row.providerId === input.transactionId,
        )
      )
        throw new EvidenceRefreshError(
          "Choose a sale from the displayed Alt evidence revision.",
        );
      const statuses = await requestEvidence([
        { kind: "alt-sale-detail", transactionId: input.transactionId },
      ]);
      ensureEvidenceWorker();
      return respond({ statuses });
    }
    if (input.intent === "next-page") {
      const revision = await getEvidenceRevision(input.revision);
      if (
        !revision ||
        !["ebay-sales", "ebay-supply"].includes(revision.payload.kind)
      )
        throw new EvidenceRefreshError("Choose an eBay evidence revision.");
      const [status] = await evidenceStatuses([revision.key]);
      const body = revision.payload.data;
      if (
        !status ||
        (status.spec.kind !== "ebay-sales" &&
          status.spec.kind !== "ebay-supply") ||
        !body ||
        !("page" in body) ||
        !body.page ||
        body.page.nextOffset === null
      )
        throw new EvidenceRefreshError("This evidence has no next page.");
      const statuses = await requestEvidence([
        { ...status.spec, offset: body.page.nextOffset },
      ]);
      ensureEvidenceWorker();
      return respond({ statuses });
    }
    throw new EvidenceRefreshError(
      "Choose refresh, cancel, sale detail or next page.",
    );
  } catch (error) {
    return failure(error);
  }
}
