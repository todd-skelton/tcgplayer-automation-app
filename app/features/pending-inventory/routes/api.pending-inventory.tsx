import { data } from "react-router";

export async function loader() {
  try {
    const { pendingInventoryDb } = await import("../../../datastores");
    const pendingInventory = await pendingInventoryDb.find({});
    return data(pendingInventory, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    const { pendingInventoryDb } = await import("../../../datastores");
    const formData = await request.json();
    const { method, sku, quantity, productLineId, setId, productId } = formData;

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

      // Require all metadata to be provided - no cross-shard lookups
      if (!productLineId || !setId || !productId) {
        return data(
          { error: "productLineId, setId, and productId are required" },
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
        // Use upsert to update existing or insert new entry atomically
        const now = new Date();
        try {
          // Try to update existing entry first
          const updateResult = await pendingInventoryDb.update(
            { sku },
            {
              $set: {
                quantity,
                updatedAt: now,
              },
            }
          );

          // If no document was updated, insert a new one
          if (updateResult === 0) {
            await pendingInventoryDb.insert({
              sku,
              quantity,
              productLineId,
              setId,
              productId,
              createdAt: now,
              updatedAt: now,
            });
          }
        } catch (error) {
          // Handle unique constraint violation gracefully
          if (
            String(error).includes("unique") ||
            String(error).includes("duplicate")
          ) {
            // If we get a duplicate key error on insert, try to update the existing record
            await pendingInventoryDb.update(
              { sku },
              {
                $set: {
                  quantity,
                  updatedAt: now,
                },
              }
            );
          } else {
            throw error;
          }
        }

        return data({ message: "Pending inventory updated" }, { status: 200 });
      }
    }

    return data({ error: "Invalid method" }, { status: 400 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
