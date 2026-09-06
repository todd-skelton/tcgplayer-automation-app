import { data } from "react-router";
import { SlabIdentityError } from "../identity/slabIdentity";
import { SlabInventoryError, sellerAccount } from "../inventory/slabInventory";
import {
  assignInventoryIdentity,
  getInventory,
  inventoryRevision,
  reconcileInventory,
  resolveInventoryIdentity,
} from "../inventory/slabInventory.server";
import { parseInventoryCsv } from "../inventory/slabInventoryCsv.server";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { ProviderRequestError } from "../connections/providerRequest.server";
import { CONNECTION_MESSAGES } from "../connections/providerConnection";

const response = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof ProviderRequestError)
    return response(
      { error: CONNECTION_MESSAGES[error.status], code: error.status },
      503,
    );
  if (error instanceof SlabInventoryError)
    return response(
      { error: error.message },
      error.code === "conflict"
        ? 409
        : error.code === "unavailable"
          ? 503
          : 400,
    );
  if (
    error instanceof SlabIdentityError ||
    error instanceof SyntaxError ||
    error instanceof TypeError
  )
    return response({ error: "Check the inventory request fields." }, 400);
  return response(
    { error: "Unable to update slab inventory. Try again." },
    500,
  );
}
export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    return response({
      ...(await getInventory(
        url.searchParams.get("seller") ?? "",
        url.searchParams.get("after") ?? "",
        Number(url.searchParams.get("limit") ?? 100),
      )),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return response({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return response(
      { error: "Submit this request from the application." },
      403,
    );
  try {
    const input = await readSlabJsonRequest(request, 3 * 1024 * 1024);
    const seller = sellerAccount(input.seller);
    if (
      input.intent === "resolve-identity" ||
      input.intent === "assign-identity"
    ) {
      if (
        typeof input.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.id) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 1
      )
        throw new SlabInventoryError(
          "invalid-input",
          "Provide a listing ID and revision.",
        );
      if (input.intent === "resolve-identity")
        return response(
          await resolveInventoryIdentity(
            seller,
            input.id,
            input.revision,
            request.signal,
          ),
        );
      if (
        typeof input.identityId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.identityId) ||
        typeof input.note !== "string"
      )
        throw new SlabInventoryError(
          "invalid-input",
          "Choose a confirmed identity and record a note.",
        );
      return response(
        await assignInventoryIdentity(
          seller,
          input.id,
          input.revision,
          input.identityId,
          input.note,
        ),
      );
    }
    const revision = input.revision;
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new SlabInventoryError(
        "invalid-input",
        "Provide the current inventory revision.",
      );
    if (revision !== (await inventoryRevision(seller)))
      throw new SlabInventoryError(
        "conflict",
        "Reload inventory before importing.",
      );
    if (input.intent === "import-csv") {
      if (typeof input.csv !== "string")
        throw new SlabInventoryError(
          "invalid-input",
          "Provide inventory CSV text.",
        );
      return response(
        await reconcileInventory(
          parseInventoryCsv(input.csv, seller),
          revision,
        ),
      );
    }
    if (input.intent === "import-manual")
      return response(
        await reconcileInventory(
          {
            seller,
            source: "manual",
            completeActiveInventory: false,
            observedAt: new Date().toISOString(),
            listings: input.listings,
          },
          revision,
        ),
      );
    throw new SlabInventoryError(
      "invalid-input",
      "Choose an inventory import or identity action.",
    );
  } catch (error) {
    return failure(error);
  }
}
