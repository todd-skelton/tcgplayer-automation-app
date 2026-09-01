import type { Sku } from "../../../shared/data-types/sku";
import {
  getAllLatestSales,
  type GetLastSalesRequestParams,
  type GetLastestSalesRequestBody,
  type Sale,
} from "../../../integrations/tcgplayer/client/get-latest-sales.server";
import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import type { ListingObservation } from "../services/supplyAnalysisService";
import {
  SupplyAnalysisService,
  type SupplyAnalysisConfig,
} from "../services/supplyAnalysisService";
import { categoryFiltersRepository } from "~/core/db";
import { PERCENTILES } from "../../../core/constants/pricing";
import type { PricingSupplyStatus } from "../../../core/types/pricingPolicy";
import {
  fitTimeAwareZipfModelToConditions,
  normalizeSalesToTargetCondition,
} from "./conditionNormalization";
import {
  estimateBuyerArrivalAtPrice,
  LATEST_SALES_LIMIT,
} from "./buyerArrivalRate";

export async function getSuggestedPriceFromLatestSales(
  sku: Sku,
  config: LatestSalesPriceConfig = {},
): Promise<{
  suggestedPrice?: number;
  lowestListingPrice?: number;
  totalQuantity: number;
  saleCount: number;
  historicalSalesVelocityMs?: number;
  estimatedTimeToSellMs?: number;
  salesCount?: number;
  listingsCount?: number;
  percentiles: PercentileData[];
  usedCrossConditionAnalysis?: boolean;
  conditionMultipliers?: Map<Condition, number>;
}> {
  const {
    halfLifeDays = 7,
    percentile = 80,
    additionalPercentiles = [],
    availableSinceTimestamp,
  } = config;

  const categoryFilter = await categoryFiltersRepository.findByCategoryId(
    sku.productLineId,
  );
  if (!categoryFilter) {
    throw new Error(
      `No category filter found for categoryId (productLineId) ${sku.productLineId}`,
    );
  }

  const languageId = categoryFilter.languages.find(
    (l: any) => l.name === sku.language,
  )?.id;
  const variantId = categoryFilter.variants.find(
    (v: any) => v.name === sku.variant,
  )?.id;
  if (!languageId) {
    throw new Error(
      `Language ${sku.language} is not available for product line ${sku.productLineId}`,
    );
  }
  if (!variantId) {
    throw new Error(
      `Variant ${sku.variant} is not available for product line ${sku.productLineId}`,
    );
  }

  const salesOptions = {
    conditions: [],
    languages: [languageId],
    variants: [variantId],
    listingType: "ListingWithoutPhotos" as const,
  };

  const fetchLatestSales = config.fetchLatestSales ?? getAllLatestSales;
  const allSales: Sale[] = await fetchLatestSales(
    { id: sku.productId },
    salesOptions,
    LATEST_SALES_LIMIT,
  );

  if (allSales.length < 2) {
    const supplyAnalysisService = new SupplyAnalysisService();
    const lowestListingPrice = config.fetchLowestListingPrice
      ? await config.fetchLowestListingPrice(sku, config.supplyAnalysisConfig)
      : await supplyAnalysisService.fetchLowestListingPrice(
          sku,
          config.supplyAnalysisConfig,
        );

    return {
      suggestedPrice: undefined,
      lowestListingPrice,
      totalQuantity: 0,
      saleCount: 0,
      percentiles: [],
      usedCrossConditionAnalysis: false,
    };
  }

  const isSealed = sku.condition === "Unopened";

  const conditionNormalization = isSealed
    ? undefined
    : fitTimeAwareZipfModelToConditions(allSales, sku.condition);
  const zipfMultipliers =
    conditionNormalization?.multipliers ?? new Map<Condition, number>();

  const salesToProcess = isSealed
    ? allSales.filter((sale) => sale.condition === "Unopened")
    : allSales;

  const adjustedSales = normalizeSalesToTargetCondition(
    salesToProcess,
    isSealed ? undefined : zipfMultipliers,
  );

  const dynamicHalfLife =
    halfLifeDays || calculateDynamicHalfLife(adjustedSales);

  let supplyObservation: ListingObservation = {
    status: config.enableSupplyAnalysis ? "unavailable" : "disabled",
    listings: [],
  };
  if (config.enableSupplyAnalysis) {
    const maxSalesPrice =
      adjustedSales.length > 0
        ? Math.max(...adjustedSales.map((s) => s.price))
        : undefined;

    const optimizedConfig = {
      ...config.supplyAnalysisConfig,
      maxSalesPrice,
    };

    if (config.fetchListingsForSku) {
      supplyObservation = await config.fetchListingsForSku(
        sku,
        optimizedConfig,
      );
    } else {
      const supplyAnalysisService = new SupplyAnalysisService();
      supplyObservation = await supplyAnalysisService.fetchListingsForSku(
        sku,
        optimizedConfig,
      );
    }
  }

  const result = getSuggestedPriceFromSales(adjustedSales, {
    halfLifeDays: dynamicHalfLife,
    percentile,
    additionalPercentiles,
    supplyObservation,
    availableSinceTimestamp,
  });

  return {
    ...result,
    usedCrossConditionAnalysis: !isSealed,
    conditionMultipliers: isSealed ? undefined : zipfMultipliers,
  };
}

export interface LatestSalesPriceConfig {
  halfLifeDays?: number;
  percentile?: number;
  additionalPercentiles?: number[];
  availableSinceTimestamp?: number;
  enableSupplyAnalysis?: boolean;
  supplyAnalysisConfig?: {
    includeUnverifiedSellers?: boolean;
    excludedSellerKey?: string;
  };
  fetchLatestSales?: (
    params: GetLastSalesRequestParams,
    body: GetLastestSalesRequestBody,
    maxSales?: number,
  ) => Promise<Sale[]>;
  fetchListingsForSku?: (
    sku: Sku,
    config: SupplyAnalysisConfig,
  ) => Promise<ListingObservation>;
  fetchLowestListingPrice?: (
    sku: Sku,
    config?: Pick<
      SupplyAnalysisConfig,
      "includeUnverifiedSellers" | "excludedSellerKey"
    >,
  ) => Promise<number | undefined>;
}

export interface PercentileData {
  percentile: number;
  price: number;
  historicalSalesVelocityMs?: number;
  estimatedTimeToSellMs?: number;
  salesCount?: number;
  historyCapped?: boolean;
  listingsCount?: number;
  storeWinShare?: number;
  supplyStatus?: PricingSupplyStatus;
}

export function getTimeDecayedPercentileWeightedSuggestedPrice(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: {
    halfLifeDays?: number;
    percentiles?: number[];
    asOfTimestamp?: number;
    availableSinceTimestamp?: number;
    supplyObservation?: ListingObservation;
  } = {},
): PercentileData[] {
  if (!sales || sales.length === 0) return [];

  const halfLifeDays = options.halfLifeDays ?? 7;
  const requestedPercentiles = options.percentiles ?? PERCENTILES;
  const supplyObservation: ListingObservation = options.supplyObservation ?? {
    status: "disabled",
    listings: [],
  };

  const now = options.asOfTimestamp ?? Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;

  const weightedSales = sales.map((sale) => {
    const ageDays = (now - sale.timestamp) / msPerDay;
    const weight = Math.pow(0.5, ageDays / halfLifeDays);
    return { ...sale, weight };
  });

  weightedSales.sort((a, b) => a.price - b.price);
  const totalWeight = weightedSales.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return [];

  let cumulative = 0;
  const cumulativeData = weightedSales.map((sale) => {
    cumulative += sale.weight;
    return {
      price: sale.price,
      cumulativeWeight: cumulative,
      percentile: (cumulative / totalWeight) * 100,
    };
  });

  const percentiles: PercentileData[] = [];

  for (const p of requestedPercentiles) {
    const targetWeight = (p / 100) * totalWeight;
    let price: number;

    if (p === 0) {
      price = cumulativeData[0].price;
    } else if (p === 100) {
      price = cumulativeData[cumulativeData.length - 1].price;
    } else {
      let lowerIndex = -1;
      let upperIndex = -1;

      for (let i = 0; i < cumulativeData.length; i++) {
        if (cumulativeData[i].cumulativeWeight >= targetWeight) {
          upperIndex = i;
          lowerIndex = i === 0 ? 0 : i - 1;
          break;
        }
      }

      if (upperIndex === -1) {
        price = cumulativeData[cumulativeData.length - 1].price;
      } else if (lowerIndex === upperIndex) {
        price = cumulativeData[upperIndex].price;
      } else {
        const lower = cumulativeData[lowerIndex];
        const upper = cumulativeData[upperIndex];
        const weightDiff = upper.cumulativeWeight - lower.cumulativeWeight;
        const targetOffset = targetWeight - lower.cumulativeWeight;
        const ratio = weightDiff === 0 ? 0 : targetOffset / weightDiff;
        price = lower.price + (upper.price - lower.price) * ratio;
      }
    }

    const historicalResult = estimateBuyerArrivalAtPrice(sales, price, {
      asOfTimestamp: now,
      halfLifeDays,
      availableSinceTimestamp: options.availableSinceTimestamp,
    });
    const historicalSalesVelocityMs = historicalResult.intervalDays
      ? Math.round(historicalResult.intervalDays * msPerDay)
      : undefined;
    const salesCount = historicalResult.qualifyingSalesCount;

    let estimatedTimeToSellMs: number | undefined;
    let listingsCount: number | undefined;
    let storeWinShare: number | undefined;

    if (supplyObservation.status === "observed") {
      const supplyAnalysisService = new SupplyAnalysisService();
      const supplyResult =
        supplyAnalysisService.calculateSupplyAdjustedTimeToSell(
          supplyObservation.listings,
          price,
          historicalSalesVelocityMs,
        );

      estimatedTimeToSellMs = supplyResult.timeMs
        ? Math.round(supplyResult.timeMs)
        : undefined;
      listingsCount = supplyResult.listingsCount;
      storeWinShare = supplyResult.storeWinShare;
    }

    percentiles.push({
      percentile: p,
      price,
      historicalSalesVelocityMs,
      estimatedTimeToSellMs,
      salesCount,
      historyCapped: historicalResult.historyCapped,
      listingsCount,
      storeWinShare,
      supplyStatus: supplyObservation.status,
    });
  }

  return percentiles;
}

export function getSuggestedPriceFromSales(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: {
    percentile?: number;
    additionalPercentiles?: number[];
    halfLifeDays?: number;
    asOfTimestamp?: number;
    availableSinceTimestamp?: number;
    supplyObservation?: ListingObservation;
  } = {},
): {
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
  historicalSalesVelocityMs?: number;
  estimatedTimeToSellMs?: number;
  salesCount?: number;
  listingsCount?: number;
  percentiles: PercentileData[];
} {
  const {
    percentile = 80,
    additionalPercentiles = [],
    supplyObservation,
    asOfTimestamp,
    availableSinceTimestamp,
  } = options;

  const halfLifeDays = options.halfLifeDays || calculateDynamicHalfLife(sales);

  const percentilesToCalculate = [
    ...new Set([...PERCENTILES, percentile, ...additionalPercentiles]),
  ].sort((a, b) => a - b);

  const percentiles = getTimeDecayedPercentileWeightedSuggestedPrice(sales, {
    halfLifeDays,
    percentiles: percentilesToCalculate,
    supplyObservation,
    asOfTimestamp,
    availableSinceTimestamp,
  });

  const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0);

  let suggestedPrice: number | undefined = undefined;
  let historicalSalesVelocityMs: number | undefined = undefined;
  let estimatedTimeToSellMs: number | undefined = undefined;
  let selectedSalesCount: number | undefined = undefined;
  let selectedListingsCount: number | undefined = undefined;

  if (sales.length > 0) {
    const targetPercentileData = percentiles.find(
      (p) => p.percentile === percentile,
    );
    if (targetPercentileData) {
      suggestedPrice = targetPercentileData.price;
      historicalSalesVelocityMs =
        targetPercentileData.historicalSalesVelocityMs;
      estimatedTimeToSellMs = targetPercentileData.estimatedTimeToSellMs;
      selectedSalesCount = targetPercentileData.salesCount;
      selectedListingsCount = targetPercentileData.listingsCount;
    }
  }

  return {
    suggestedPrice,
    totalQuantity,
    saleCount: sales.length,
    historicalSalesVelocityMs,
    estimatedTimeToSellMs,
    salesCount: selectedSalesCount,
    listingsCount: selectedListingsCount,
    percentiles,
  };
}

function calculateDynamicHalfLife(
  sales: { price: number; quantity: number; timestamp: number }[],
): number {
  if (sales.length <= 1) {
    return Infinity;
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
  const timeSpanMs = timestamps[timestamps.length - 1] - timestamps[0];
  const avgIntervalMs = timeSpanMs / (sales.length - 1);

  const intervalsPerHalfLife = 24;
  const halfLifeMs = avgIntervalMs * intervalsPerHalfLife;

  const minHalfLifeMs = msPerDay;

  return Math.max(minHalfLifeMs, Math.round(halfLifeMs)) / msPerDay;
}
