import { data } from "react-router";
import { inventoryBatchesRepository } from "~/core/db";

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

export async function loader({ params }: { params: { batchNumber?: string } }) {
  try {
    const batchNumber = parseBatchNumber(params.batchNumber);
    if (!batchNumber) {
      return data({ error: "Invalid batch number" }, { status: 400 });
    }

    const batch = await inventoryBatchesRepository.findByBatchNumber(batchNumber);
    if (!batch) {
      return data({ error: `Batch ${batchNumber} not found` }, { status: 404 });
    }

    return data(batch, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({
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

    if (request.method !== "DELETE") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const deleted = await inventoryBatchesRepository.deleteBatch(batchNumber);
    if (!deleted) {
      return data({ error: `Batch ${batchNumber} not found` }, { status: 404 });
    }

    return data({ message: `Batch ${batchNumber} deleted` }, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
