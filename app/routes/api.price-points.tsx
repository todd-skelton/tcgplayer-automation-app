import { data } from "react-router";
import {
  getPricePoints,
  type GetPricePointsRequestBody,
} from "~/tcgplayer/get-price-points";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body: GetPricePointsRequestBody = await request.json();
    const { skuIds } = body;

    if (!skuIds || !Array.isArray(skuIds) || skuIds.length === 0) {
      return data({ error: "SKU IDs array is required" }, { status: 400 });
    }

    // Validate SKU IDs are numbers
    const validSkuIds = skuIds.filter((id) => typeof id === "number" && id > 0);
    if (validSkuIds.length === 0) {
      return data({ error: "No valid SKU IDs provided" }, { status: 400 });
    }

    // Fetch price points from TCGPlayer API
    const pricePoints = await getPricePoints({ skuIds: validSkuIds });

    return data({
      pricePoints,
      totalSkus: validSkuIds.length,
      foundPrices: pricePoints.length,
    });
  } catch (error: any) {
    console.error("Error fetching price points:", error);
    return data(
      {
        error: error?.message || "Failed to fetch price points",
        pricePoints: [],
        totalSkus: 0,
        foundPrices: 0,
      },
      { status: 500 }
    );
  }
}

// No default export - this is an API-only route
