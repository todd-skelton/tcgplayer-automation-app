import { data } from "react-router";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { SlabInventoryError } from "../inventory/slabInventory";
import { SellerOutcomeError } from "../supply/sellerOutcomeCsv.server";
import {
  importSellerOutcomeCsv,
  readSellerOutcomes,
} from "../supply/sellerOutcomes.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof SellerOutcomeError ||
        error instanceof SlabInventoryError
          ? error.message
          : "Seller outcomes are unavailable.",
    },
    error instanceof SellerOutcomeError ||
      error instanceof SlabInventoryError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
      ? 400
      : 500,
  );
export async function loader({ request }: { request: Request }) {
  try {
    const params = new URL(request.url).searchParams;
    return respond(
      await readSellerOutcomes(
        params.get("seller") ?? "",
        params.get("itemId") ?? "",
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return respond({ error: "Import outcomes from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 512 * 1024);
    if (input.intent !== "import-csv")
      throw new SellerOutcomeError("Choose a reviewed outcome CSV import.");
    return respond(await importSellerOutcomeCsv(input.csv, input.seller));
  } catch (error) {
    return failure(error);
  }
}
