import type { Sku } from "../../../shared/data-types/sku";
import {
  getAllLatestSales,
  type GetLastSalesRequestParams,
  type GetLastestSalesRequestBody,
  type Sale,
} from "../../../integrations/tcgplayer/client/get-latest-sales.server";
import {
  fetchAnnualPriceHistory,
  type GetPriceHistoryResponse,
} from "../../../integrations/tcgplayer/client/get-price-history.server";
import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import type { ListingObservation } from "../services/supplyAnalysisService";
import {
  SupplyAnalysisService,
  type SupplyAnalysisConfig,
} from "../services/supplyAnalysisService";
import { categoryFiltersRepository } from "~/core/db";
import { PERCENTILES } from "../../../core/constants/pricing";
import type {
  ConditionNormalizationDetail,
  ConditionSaleRate,
  PriceEvidence,
} from "../../../core/types/pricing";
import type { PricingSupplyStatus } from "../../../core/types/pricingPolicy";
import {
  competingAskCeiling,
  fitTimeAwareZipfModelToConditions,
  normalizeListingsToTargetCondition,
  normalizeSalesToTargetCondition,
} from "./conditionNormalization";
import {
  estimateBuyerArrivalAtPrice,
  LATEST_SALES_HISTORY_DAYS,
  LATEST_SALES_LIMIT,
} from "./buyerArrivalRate";
import { estimateConditionSaleRate } from "./conditionSaleRate";
import { getEffectiveSalePrice } from "./getEffectiveSalePrice";

const DAY_MS = 24 * 60 * 60 * 1000;

const supplyAnalysisService = new SupplyAnalysisService();
const defaultFetchListingsForProduct: NonNullable<
  LatestSalesPriceConfig["fetchListingsForProduct"]
> = (sku, config) => supplyAnalysisService.fetchListingsForProduct(sku, config);

/** Latest market price of each condition of the SKU's product, variant, and language. */
function siblingMarketPrices(
  priceHistory: GetPriceHistoryResponse | undefined,
  sku: Sku,
): Map<Condition, number> {
  return new Map(
    (priceHistory?.result ?? [])
      .filter(
        (entry) =>
          entry.variant === sku.variant && entry.language === sku.language,
      )
      .flatMap((entry): [Condition, number][] => {
        const latest = entry.buckets.reduce<
          (typeof entry.buckets)[number] | undefined
        >(
          (best, bucket) =>
            Number(bucket.marketPrice) > 0 &&
            (!best ||
              new Date(bucket.bucketStartDate).getTime() >
                new Date(best.bucketStartDate).getTime())
              ? bucket
              : best,
          undefined,
        );
        const marketPrice = Number(latest?.marketPrice);
        return marketPrice > 0
          ? [[entry.condition as Condition, marketPrice]]
          : [];
      }),
  );
}

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
  conditionNormalization?: ConditionNormalizationDetail;
  conditionSaleRate?: ConditionSaleRate;
  priceEvidence?: PriceEvidence;
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
  const fetchPriceHistory = config.fetchPriceHistory ?? fetchAnnualPriceHistory;
  const priceHistory = await fetchPriceHistory(sku.productId);
  const ownHistory = priceHistory?.result.find(
    (entry) => Number(entry.skuId) === sku.sku,
  );
  const conditionSaleRate =
    ownHistory &&
    estimateConditionSaleRate(ownHistory.buckets, { availableSinceTimestamp });

  const siblings = siblingMarketPrices(priceHistory, sku);
  const conditionNormalization = isSealed
    ? undefined
    : fitTimeAwareZipfModelToConditions(allSales, sku.condition, {
        siblingMarketPrices: siblings,
      });
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

  const fetchListingsForProduct =
    config.fetchListingsForProduct ?? defaultFetchListingsForProduct;
  const productListings: ListingObservation = config.enableSupplyAnalysis
    ? await fetchListingsForProduct(sku, {
        ...config.supplyAnalysisConfig,
        maxSalesPrice: isSealed
          ? salesToProcess.length > 0
            ? Math.max(...salesToProcess.map(getEffectiveSalePrice))
            : undefined
          : competingAskCeiling(salesToProcess, { siblingMarketPrices: siblings }),
      })
    : { status: "disabled", listings: [] };
  const ownConditionListings = productListings.listings.filter(
    (listing) => listing.condition === sku.condition,
  );
  // Sealed products compete only with sealed listings.
  const supplyObservation: ListingObservation = {
    status: productListings.status,
    listings: isSealed
      ? ownConditionListings
      : normalizeListingsToTargetCondition(
          productListings.listings,
          zipfMultipliers,
        ),
  };

  const windowStart = Date.now() - LATEST_SALES_HISTORY_DAYS * DAY_MS;
  const ownConditionSalePrices = allSales
    .filter(
      (sale) =>
        sale.condition === sku.condition &&
        new Date(sale.orderDate).getTime() >= windowStart,
    )
    .map(getEffectiveSalePrice)
    .filter((price) => price > 0);
  // Without the store's own listing excluded, the second ask may be the
  // cheapest competitor, the one most often mis-conditioned.
  const secondCheapestAsk = config.supplyAnalysisConfig?.excludedSellerKey
    ? ownConditionListings[1]
    : undefined;
  const ownConditionLowSalePrice = ownConditionSalePrices.length
    ? Math.min(...ownConditionSalePrices)
    : undefined;
  const secondCheapestAskPrice = secondCheapestAsk
    ? secondCheapestAsk.price + secondCheapestAsk.shippingCost
    : undefined;
  const priceEvidence: PriceEvidence | undefined =
    ownConditionLowSalePrice === undefined &&
    secondCheapestAskPrice === undefined
      ? undefined
      : { ownConditionLowSalePrice, secondCheapestAskPrice };

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
    conditionNormalization: conditionNormalization?.diagnostics,
    conditionSaleRate,
    priceEvidence,
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
  fetchPriceHistory?: (
    productId: number,
  ) => Promise<GetPriceHistoryResponse | undefined>;
  fetchListingsForProduct?: (
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
