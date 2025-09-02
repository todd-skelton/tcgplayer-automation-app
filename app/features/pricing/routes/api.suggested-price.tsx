import { getSuggestedPriceFromLatestSales } from "../algorithms/getSuggestedPriceFromLatestSales";
import { productsDb } from "../../../datastores";
import { data } from "react-router";
import type { Product } from "../../inventory-management/types/product";
import { calculateMarketplacePrice } from "../services/pricingService";

// Simple API endpoint to get suggested price for a single product
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const {
      tcgplayerId,
      percentile = 65,
      enableSupplyAnalysis = false,
      supplyAnalysisConfig = {},
    } = body;

    if (!tcgplayerId) {
      return data({ error: "TCGplayer ID is required" }, { status: 400 });
    }

    // Look up the SKU by finding the product that contains this SKU
    const skuId = Number(tcgplayerId);

    // Find the product that contains this SKU instead of querying SKU database directly
    const product = await productsDb.findOne<Product>({
      "skus.sku": skuId,
    });

    if (!product) {
      return data(
        {
          error: `SKU ${skuId} not found in any product`,
          suggestedPrice: null,
        },
        { status: 404 }
      );
    }

    // Find the specific SKU within the product
    const productSku = product.skus.find((sku) => sku.sku === skuId);
    if (!productSku) {
      return data(
        {
          error: `SKU ${skuId} not found in product ${product.productId}`,
          suggestedPrice: null,
        },
        { status: 404 }
      );
    }

    // Convert ProductSku to full Sku format
    const sku = {
      ...productSku,
      productTypeName: product.productTypeName,
      rarityName: product.rarityName,
      sealed: product.sealed,
      productName: product.productName,
      setId: product.setId,
      setCode: product.setCode,
      productId: product.productId,
      setName: product.setName,
      productLineId: product.productLineId,
      productStatusId: product.productStatusId,
      productLineName: product.productLineName,
    };

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
