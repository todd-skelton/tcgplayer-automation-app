import { getSuggestedPriceFromLatestSales } from "~/algorithms/getSuggestedPriceFromLatestSales";
import { skusDb } from "~/datastores";
import { data } from "react-router";

// Simple API endpoint to get suggested price for a single product
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { tcgplayerId, percentile = 65 } = body;

    if (!tcgplayerId) {
      return data({ error: "TCGplayer ID is required" }, { status: 400 });
    }

    // Look up the SKU in the database
    const skuId = Number(tcgplayerId);
    const sku = await skusDb.findOne({ sku: skuId });
    if (!sku) {
      return data(
        {
          error: `SKU ${skuId} not found in database`,
          suggestedPrice: null,
        },
        { status: 404 }
      );
    } // Get suggested price from the algorithm
    const result = await getSuggestedPriceFromLatestSales(sku, { percentile });

    return result;
  } catch (error: any) {
    console.error("Error getting suggested price:", error);
    return data(
      {
        error: error?.message || "Failed to get suggested price",
        suggestedPrice: null,
      },
      { status: 500 }
    );
  }
}

// No default export - this is an API-only route
