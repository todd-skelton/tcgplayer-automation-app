import { data } from "react-router";
import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import { SlabInventoryError } from "../inventory/slabInventory";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { loadSlabSupply, requestSlabSupply } from "../supply/slabSupply.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof EvidenceRefreshError ||
        error instanceof SlabInventoryError
          ? error.message
          : "Unable to load slab supply context.",
    },
    error instanceof EvidenceRefreshError ||
      error instanceof SlabInventoryError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
      ? 400
      : 500,
  );
export async function loader({ request }: { request: Request }) {
  try {
    const p = new URL(request.url).searchParams;
    return respond(
      await loadSlabSupply({
        slabId: p.get("slabId") ?? "",
        grade: p.get("grade") ?? "owned",
        seller: p.get("seller") ?? "",
        window: { from: p.get("from") ?? "", to: p.get("to") ?? "" },
        key: p.get("key") ?? undefined,
        offset: Number(p.get("offset") ?? 0),
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return respond({ error: "Refresh supply from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 16384);
    if (input.intent !== "refresh")
      throw new EvidenceRefreshError("Choose an explicit supply refresh.");
    return respond(await requestSlabSupply(input));
  } catch (error) {
    return failure(error);
  }
}
