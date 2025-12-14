import { getSuggestedPriceFromLatestSales } from "../algorithms/getSuggestedPriceFromLatestSales";
import { data } from "react-router";
import type { Product } from "../../inventory-management/types/product";
import type { Sku } from "../../../shared/data-types/sku";
import { calculateMarketplacePrice } from "../services/pricingService";
import { skusDb, productsDb } from "~/datastores.server";

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
      enableSupplyAnalysis = false,
      supplyAnalysisConfig = {},
    } = body;

    if (!tcgplayerId) {
      return data({ error: "TCGplayer ID is required" }, { status: 400 });
    }

    if (!productLineId) {
      return data({ error: "Product line ID is required" }, { status: 400 });
    }

    // Look up the SKU directly from the SKU database using shard-targeted query
    const skuId = Number(tcgplayerId);
    const sku = await skusDb.findOne<Sku>({
      sku: skuId,
      productLineId: Number(productLineId),
    });

    if (!sku) {
      return data(
        {
          error: `SKU ${skuId} not found`,
          suggestedPrice: null,
        },
        { status: 404 }
      );
    }

    // Now we can find the product efficiently using the productLineId from the SKU
    const product = await productsDb.findOne<Product>({
      productId: sku.productId,
      productLineId: sku.productLineId,
    });

    if (!product) {
      return data(
        {
          error: `Product ${sku.productId} not found for SKU ${skuId}`,
          suggestedPrice: null,
        },
        { status: 404 }
      );
    }

    // Get suggested price from the algorithm
    const algorithmResult = await getSuggestedPriceFromLatestSales(sku, {
      percentile,
      enableSupplyAnalysis,
      supplyAnalysisConfig,
    });

    // Return the original algorithm result without applying bounds here
    // The bounds will be applied in the pricing pipeline
    const result = {
      suggestedPrice: algorithmResult.suggestedPrice,
      historicalSalesVelocityMs: algorithmResult.historicalSalesVelocityMs,
      estimatedTimeToSellMs: algorithmResult.estimatedTimeToSellMs || null,
      salesCount: algorithmResult.salesCount,
      listingsCount: algorithmResult.listingsCount,
      percentiles: algorithmResult.percentiles,
    };

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
