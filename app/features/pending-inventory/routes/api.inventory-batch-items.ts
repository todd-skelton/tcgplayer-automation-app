import { data } from "react-router";
import { inventoryBatchesRepository } from "~/core/db";

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

export async function loader({
  params,
  request,
}: {
  params: { batchNumber?: string };
  request: Request;
}) {
  try {
    const batchNumber = parseBatchNumber(params.batchNumber);
    if (!batchNumber) {
      return data({ error: "Invalid batch number" }, { status: 400 });
    }

    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") === "errors" ? "errors" : "all";
    const items = await inventoryBatchesRepository.findItems(batchNumber, scope);
    return data(items, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
