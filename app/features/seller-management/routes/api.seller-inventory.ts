import { data } from "react-router";
import { fetchSellerInventorySnapshot } from "~/features/seller-management/services/sellerInventorySnapshot.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { sellerKey, excludeProductLineIds } = body;

    if (!sellerKey) {
      return data({ error: "Seller key is required" }, { status: 400 });
    }

    const result = await fetchSellerInventorySnapshot({
      sellerKey,
      excludeProductLineIds,
    });

    return data(result);
  } catch (error: any) {
    console.error("Error fetching seller inventory:", error);
    return data(
      {
        error: error?.message || "Failed to fetch seller inventory",
        inventory: [],
        totalProducts: 0,
      },
      { status: 500 },
    );
  }
}
