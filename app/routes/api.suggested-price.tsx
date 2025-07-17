import { getSuggestedPriceFromLatestSales } from "~/algorithms/getSuggestedPriceFromLatestSales";
import { productsDb } from "~/datastores";
import { data } from "react-router";
import type { Product } from "~/data-types/product";
import { calculateMarketplacePrice } from "~/services/pricingService";
import { getPricePoints } from "~/tcgplayer/get-price-points";

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
    });

    // Apply minimum price bounds if we have a suggested price
    let finalSuggestedPrice = algorithmResult.suggestedPrice;
    let errorMessage = "";

    if (
      algorithmResult.suggestedPrice !== null &&
      algorithmResult.suggestedPrice !== undefined
    ) {
      try {
        // Get price points for market price data
        const pricePoints = await getPricePoints({ skuIds: [skuId] });
        const pricePoint = pricePoints.length > 0 ? pricePoints[0] : null;

        // Apply minimum price bounds
        const { marketplacePrice, errorMessage: boundsErrorMessage } =
          calculateMarketplacePrice(
            algorithmResult.suggestedPrice,
            pricePoint
              ? {
                  marketPrice: pricePoint.marketPrice,
                  lowestPrice: pricePoint.lowestPrice,
                  highestPrice: pricePoint.highestPrice,
                  calculatedAt: pricePoint.calculatedAt,
                }
              : null
          );

        // Update the suggested price with the bounded price
        finalSuggestedPrice = marketplacePrice;
        errorMessage = boundsErrorMessage;
      } catch (pricePointError) {
        // If we can't get price points, proceed without bounds checking
        console.warn(
          `Could not get price points for SKU ${skuId}:`,
          pricePointError
        );
      }
    }

    // Return result in SuggestedPriceResult format
    const result = {
      suggestedPrice: finalSuggestedPrice,
      expectedTimeToSellDays: algorithmResult.expectedTimeToSellDays,
      percentiles: algorithmResult.percentiles,
      ...(errorMessage && { error: errorMessage }),
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
