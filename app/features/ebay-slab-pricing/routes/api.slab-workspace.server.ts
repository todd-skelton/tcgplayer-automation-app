import { data } from "react-router";
import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import { loadSlabWorkspace } from "../research/slabResearch.server";
export async function loader({ request }: { request: Request }) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const p = new URL(request.url).searchParams;
    return data(
      await loadSlabWorkspace(p.get("id") ?? "", p.get("grade") ?? "owned", {
        from: p.get("from") ?? "",
        to: p.get("to") ?? "",
      }),
      { headers },
    );
  } catch (error) {
    return data(
      {
        error:
          error instanceof EvidenceRefreshError
            ? error.message
            : "Unable to open the slab workspace.",
      },
      { status: error instanceof EvidenceRefreshError ? 400 : 500, headers },
    );
  }
}
