import { data } from "react-router";
import { pendingInventoryDb } from "../../../datastores";

export async function loader() {
  try {
    const pendingInventory = await pendingInventoryDb.find({});
    return data(pendingInventory, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    const formData = await request.json();
    const { method, sku, quantity } = formData;

    if (method === "DELETE") {
      // Clear all pending inventory
      await pendingInventoryDb.remove({}, { multi: true });
      return data(
        { message: "All pending inventory cleared" },
        { status: 200 }
      );
    }

    if (method === "PUT") {
      // Update or insert a pending inventory entry
      if (!sku || typeof quantity !== "number") {
        return data(
          { error: "SKU and quantity are required" },
          { status: 400 }
        );
      }

      if (quantity <= 0) {
        // Remove the entry if quantity is 0 or negative
        await pendingInventoryDb.remove({ sku }, { multi: false });
        return data(
          { message: "Pending inventory entry removed" },
          { status: 200 }
        );
      } else {
        // Update or insert the entry
        const existing = await pendingInventoryDb.findOne({ sku });
        if (existing) {
          await pendingInventoryDb.update(
            { sku },
            {
              $set: {
                quantity,
                updatedAt: new Date(),
              },
            }
          );
        } else {
          await pendingInventoryDb.insert({
            sku,
            quantity,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        return data({ message: "Pending inventory updated" }, { status: 200 });
      }
    }

    return data({ error: "Invalid method" }, { status: 400 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
