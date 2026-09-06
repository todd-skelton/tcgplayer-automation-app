import { data } from "react-router";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { SlabPublicationError } from "../publication/slabPublicationPreview";
import { dryRunSlabPublication } from "../publication/slabPublicationExecution.server";
import {
  getPublication,
  publicationEvents,
  publicationHistory,
} from "../publication/slabPublicationStore.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof SlabPublicationError
          ? error.message
          : "Unable to access slab publication.",
    },
    error instanceof SlabPublicationError ||
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
        publication: await getPublication(id),
        events: await publicationEvents(id),
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
    return respond({ error: "Run the dry run from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 16384);
    if (input.intent !== "dry-run")
      return respond(
        {
          error:
            "Live seller publication is not connected. Only an imported-inventory dry run is available.",
        },
        503,
      );
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
