import type {
  PriceEvidence,
  SuggestedPriceResult,
} from "../../../core/types/pricing";
import { PRICING_CONSTANTS } from "../../../core/constants/pricing";

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

export interface MinimumMarketplacePriceConfig {
  minPriceMultiplier: number;
  minPriceConstant: number;
}

export interface InsufficientSalesFallbackResult {
  price: number;
  warningMessage: string;
  basis:
    | "market-reference"
    | "listing-reference"
    | "market-and-listing-reference"
    | "current-price";
}

function normalizePositivePrice(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateInsufficientSalesFallback(input: {
  marketPrice?: number;
  lowestListingPrice?: number;
  currentPrice?: number;
}): InsufficientSalesFallbackResult | null {
  const marketPrice = normalizePositivePrice(input.marketPrice);
  const lowestListingPrice = normalizePositivePrice(input.lowestListingPrice);

  if (marketPrice !== null || lowestListingPrice !== null) {
    const price = Math.max(marketPrice ?? 0, lowestListingPrice ?? 0);
    const availableReferences = [
      marketPrice === null ? null : `TCG market $${marketPrice.toFixed(2)}`,
      lowestListingPrice === null
        ? null
        : `lowest delivered listing $${lowestListingPrice.toFixed(2)}`,
    ].filter((reference): reference is string => reference !== null);

    return {
      price,
      basis:
        marketPrice !== null && lowestListingPrice !== null
          ? "market-and-listing-reference"
          : marketPrice !== null
            ? "market-reference"
            : "listing-reference",
      warningMessage: `Insufficient sales history. Using the highest available reference price (${availableReferences.join(", ")}): $${price.toFixed(2)}.`,
    };
  }

  const currentPrice = normalizePositivePrice(input.currentPrice);
  if (currentPrice === null) {
    return null;
  }

  return {
    price: currentPrice,
    basis: "current-price",
    warningMessage: `Insufficient sales history and no market price or listing is available. Keeping the current price at $${currentPrice.toFixed(2)}.`,
  };
}

const DEFAULT_MINIMUM_MARKETPLACE_PRICE_CONFIG: MinimumMarketplacePriceConfig =
  {
    minPriceMultiplier: PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER,
    minPriceConstant: PRICING_CONSTANTS.MIN_PRICE_CONSTANT,
  };

/**
 * Applies the price floor: the market-based minimum, lowered to the SKU's
 * own-condition low sale or the second-cheapest competing ask when either
 * shows the market lower. Without a market price there is no floor.
 */
export const calculateMarketplacePrice = (
  suggestedPrice: number,
  pricePoint: PricePointData | null,
  minimumPriceConfig: MinimumMarketplacePriceConfig = DEFAULT_MINIMUM_MARKETPLACE_PRICE_CONFIG,
  evidence: PriceEvidence = {},
): PriceCalculationResult => {
  const marketPrice = pricePoint?.marketPrice || 0;
  let marketplacePrice = suggestedPrice;
  let warningMessage = "";

  if (suggestedPrice > 0 && marketPrice === 0) {
    warningMessage =
      "No market price available. Using suggested price directly.";
  } else if (suggestedPrice > 0) {
    const lowerBound = Math.min(
      marketPrice * minimumPriceConfig.minPriceMultiplier -
        minimumPriceConfig.minPriceConstant,
      ...[
        evidence.ownConditionLowSalePrice,
        evidence.secondCheapestAskPrice,
      ].filter((price): price is number => price !== undefined && price > 0),
    );
    if (suggestedPrice < lowerBound) {
      marketplacePrice = lowerBound;
      warningMessage = "Suggested price below minimum. Using minimum price.";
    }
  }

  return { marketplacePrice, warningMessage, errorMessage: "" };
};

export const getSuggestedPrice = async (
  tcgplayerId: string,
  percentile: number,
  additionalPercentiles?: number[],
  enableSupplyAnalysis?: boolean,
  supplyAnalysisConfig?: {
    includeUnverifiedSellers?: boolean;
    excludedSellerKey?: string;
  },
  productLineId?: number,
): Promise<SuggestedPriceResult> => {
  try {
    const response = await fetch("/api/suggested-price", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tcgplayerId,
        percentile,
        additionalPercentiles,
        enableSupplyAnalysis,
        supplyAnalysisConfig,
        productLineId,
      }),
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
