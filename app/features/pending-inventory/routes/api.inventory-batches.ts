import { data } from "react-router";
import { inventoryBatchesRepository } from "~/core/db";

export async function loader() {
  try {
    const batches = await inventoryBatchesRepository.findAll();
    return data(batches, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const batch = await inventoryBatchesRepository.createFromPendingInventory();
    if (!batch) {
      return data(
        { error: "No pending inventory items available to batch" },
        { status: 400 },
      );
    }

    return data(batch, { status: 201 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
