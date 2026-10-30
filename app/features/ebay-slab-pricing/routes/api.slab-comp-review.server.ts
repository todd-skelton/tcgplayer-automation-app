import { data } from "react-router";
import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import { CompReviewError } from "../screening/compDecisions.server";
import { loadCompReview } from "../screening/slabCompReview.server";

// The comp review a server-drawn screen shows: a page of a saved revision's sales, screened.
export async function loader({ request }: { request: Request }) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const p = new URL(request.url).searchParams;
    return data(
      await loadCompReview({
        id: p.get("id") ?? "",
        grade: p.get("grade") ?? "owned",
        window: { from: p.get("from") ?? "", to: p.get("to") ?? "" },
        revision: p.get("revision") ?? "",
        offset: Number(p.get("offset") ?? 0),
      }),
      { headers },
    );
  } catch (error) {
    const known =
      error instanceof EvidenceRefreshError ||
      error instanceof CompReviewError;
    return data(
      {
        error: known
          ? error.message
          : "Unable to open the comp review.",
      },
      { status: known ? 400 : 500, headers },
    );
  }
}
