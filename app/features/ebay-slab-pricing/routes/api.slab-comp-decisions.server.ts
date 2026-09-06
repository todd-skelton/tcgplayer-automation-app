import { data } from "react-router";
import {
  CompReviewError,
  getCompDecisions,
  saveCompDecision,
} from "../screening/compDecisions.server";
import { readSlabJsonRequest } from "../readJsonRequest.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof CompReviewError
          ? error.message
          : "Unable to save the comp review.",
    },
    error instanceof CompReviewError && error.code === "conflict"
      ? 409
      : error instanceof CompReviewError ||
          error instanceof SyntaxError ||
          error instanceof TypeError
        ? 400
        : 500,
  );
export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    return respond({
      decisions: await getCompDecisions(
        url.searchParams.get("group") ?? "",
        (url.searchParams.get("revisions") ?? "").split(",").filter(Boolean),
      ),
    });
  } catch (error) {
    return failure(error);
  }
}
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return respond({ error: "Submit this review from the application." }, 403);
  try {
    return respond({
      decision: await saveCompDecision(
        await readSlabJsonRequest(request, 16384),
      ),
    });
  } catch (error) {
    return failure(error);
  }
}
