import { data } from "react-router";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { SlabPublicationError } from "../publication/slabPublicationPreview";
import {
  readPublicationPreview,
  preparePublicationPreview,
} from "../publication/slabPublicationPreviews.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  return respond(
    {
      error:
        error instanceof SlabPublicationError
          ? error.message
          : "Unable to access the price-change preview.",
    },
    error instanceof SlabPublicationError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
      ? 400
      : 500,
  );
}
export async function loader({ request }: { request: Request }) {
  try {
    const p = new URL(request.url).searchParams;
    return respond(
      await readPublicationPreview({
        id: p.get("id") ?? undefined,
        inventoryId: p.get("inventoryId") ?? undefined,
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
    return respond({ error: "Prepare the preview from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 16384);
    if (input.intent !== "prepare")
      throw new SlabPublicationError(
        "Only price-change previews are available. No publishing action is connected.",
      );
    return respond(await preparePublicationPreview(input));
  } catch (error) {
    return failure(error);
  }
}
