import { data } from "react-router";
import { resolveSuggestedPrice } from "../services/suggestedPriceResolver.server";

// Simple API endpoint to get suggested price for a single product
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const {
      tcgplayerId,
      productLineId,
      percentile = 65,
      additionalPercentiles = [],
      enableSupplyAnalysis = false,
      supplyAnalysisConfig = {},
    } = body;

    if (!tcgplayerId) {
      return data({ error: "TCGplayer ID is required" }, { status: 400 });
    }

    if (!productLineId) {
      return data({ error: "Product line ID is required" }, { status: 400 });
    }

    const result = await resolveSuggestedPrice({
      tcgplayerId,
      productLineId,
      percentile,
      additionalPercentiles,
      enableSupplyAnalysis,
      supplyAnalysisConfig,
    });

    if (result.error?.includes("not found")) {
      return data(result, { status: 404 });
    }

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
