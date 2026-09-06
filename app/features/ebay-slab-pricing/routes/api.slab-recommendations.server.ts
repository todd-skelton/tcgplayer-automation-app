import { data } from "react-router";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import {
  calculateSlabRecommendation,
  getSlabRecommendation,
  overrideSlabPrice,
} from "../valuation/slabRecommendations.server";
import { SlabValuationError } from "../valuation/slabValuation";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof SlabValuationError
          ? error.message
          : "Unable to calculate a slab recommendation.",
    },
    error instanceof SlabValuationError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
      ? 400
      : 500,
  );
export async function loader({ request }: { request: Request }) {
  try {
    const record = await getSlabRecommendation(
      new URL(request.url).searchParams.get("id") ?? "",
    );
    return record
      ? respond(record)
      : respond({ error: "Recommendation not found." }, 404);
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
    if (input.intent === "calculate")
      return respond(await calculateSlabRecommendation(input));
    if (input.intent === "override")
      return respond(await overrideSlabPrice(input));
    throw new SlabValuationError("Choose calculate or override.");
  } catch (error) {
    return failure(error);
  }
}
