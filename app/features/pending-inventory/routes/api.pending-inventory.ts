import { data } from "react-router";
import { pendingInventoryRepository } from "~/core/db";

export async function loader() {
  try {
    const pendingInventory = await pendingInventoryRepository.findAll();
    return data(pendingInventory, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    const formData = await request.json();
    const { method, sku, quantity, productLineId, setId, productId } = formData;

    if (method === "DELETE") {
      await pendingInventoryRepository.clearAll();
      return data({ message: "All pending inventory cleared" }, { status: 200 });
    }

    if (method === "PUT") {
      if (!sku || typeof quantity !== "number") {
        return data({ error: "SKU and quantity are required" }, { status: 400 });
      }

      if (!productLineId || !setId || !productId) {
        return data(
          { error: "productLineId, setId, and productId are required" },
          { status: 400 },
        );
      }

      if (quantity <= 0) {
        await pendingInventoryRepository.removeBySku(sku);
        return data(
          { message: "Pending inventory entry removed" },
          { status: 200 },
        );
      }

      const now = new Date();
      await pendingInventoryRepository.upsert({
        sku,
        quantity,
        productLineId,
        setId,
        productId,
        createdAt: now,
        updatedAt: now,
      });

      return data({ message: "Pending inventory updated" }, { status: 200 });
    }

    return data({ error: "Invalid method" }, { status: 400 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
