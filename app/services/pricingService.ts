import type { SuggestedPriceResult } from "../types/pricing";
import { PRICING_CONSTANTS } from "../constants/pricing";

export interface PriceCalculationResult {
  marketplacePrice: number;
  warningMessage?: string;
  errorMessage?: string;
}

export interface PricePointData {
  marketPrice?: number;
  lowestPrice?: number;
  highestPrice?: number;
  saleCount?: number;
  calculatedAt?: string;
}

/**
 * Calculates the marketplace price with bounds checking and error handling
 * This function ensures consistent pricing logic across all processors
 */
export const calculateMarketplacePrice = (
  suggestedPrice: number,
  pricePoint: PricePointData | null
): PriceCalculationResult => {
  const marketPrice = pricePoint?.marketPrice || 0;
  let marketplacePrice = suggestedPrice;
  let warningMessage = "";
  let errorMessage = "";

  // Case 1: No market price available
  if (marketPrice === 0 && suggestedPrice > 0) {
    warningMessage =
      "No market price available. Using suggested price directly.";
    return { marketplacePrice, warningMessage, errorMessage };
  }

  // Case 2: Market price available - enforce lower bound only
  if (marketPrice > 0 && suggestedPrice > 0) {
    const lowerBound =
      marketPrice * PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER -
      PRICING_CONSTANTS.MIN_PRICE_CONSTANT;

    if (suggestedPrice < lowerBound) {
      marketplacePrice = lowerBound;
      warningMessage = "Suggested price below minimum. Using minimum price.";
    }
  }

  return { marketplacePrice, warningMessage, errorMessage };
};

export const getSuggestedPrice = async (
  tcgplayerId: string,
  percentile: number
): Promise<SuggestedPriceResult> => {
  try {
    const response = await fetch("/api/suggested-price", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tcgplayerId, percentile }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error("Error getting suggested price:", error);
    return {
      error: error?.message || "Failed to get suggested price",
      suggestedPrice: null,
    };
  }
};
