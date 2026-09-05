import type {
  SuggestedPriceResolverInput,
  SuggestedPriceResult,
} from "~/core/types/pricing";
import {
  categorySetsRepository,
  productsRepository,
  skusRepository,
} from "~/core/db";
import { getSuggestedPriceFromLatestSales } from "../algorithms/getSuggestedPriceFromLatestSales";
import type { PricingBatchApiCache } from "./pricingBatchApiCache.server";
import { fetchListingsForProductAndRecord } from "./productListingSnapshotsLedger.server";
import { fetchLatestSalesAndRecord } from "./productSalesLedger.server";
import { fetchAnnualPriceHistoryAndRecord } from "./productWeeklySalesLedger.server";

interface ResolveSuggestedPriceOptions {
  batchApiCache?: PricingBatchApiCache;
}

export async function resolveSuggestedPrice(
  {
    tcgplayerId,
    percentile = 65,
    additionalPercentiles = [],
    enableSupplyAnalysis = false,
    supplyAnalysisConfig = {},
    productLineId,
  }: SuggestedPriceResolverInput,
  options: ResolveSuggestedPriceOptions = {},
): Promise<SuggestedPriceResult> {
  if (!tcgplayerId) {
    return { error: "TCGplayer ID is required", suggestedPrice: null };
  }

  if (!productLineId) {
    return { error: "Product line ID is required", suggestedPrice: null };
  }

  const skuId = Number(tcgplayerId);
  const sku = await skusRepository.findBySkuAndProductLine(
    skuId,
    Number(productLineId),
  );

  if (!sku) {
    return {
      error: `SKU ${skuId} not found`,
      suggestedPrice: null,
    };
  }

  const [product, categorySet] = await Promise.all([
    productsRepository.findByProductId(sku.productId, sku.productLineId),
    categorySetsRepository.findByCategoryIdAndSetNameId(
      sku.productLineId,
      sku.setId,
    ),
  ]);

  if (!product) {
    return {
      error: `Product ${sku.productId} not found for SKU ${skuId}`,
      suggestedPrice: null,
    };
  }

  const algorithmResult = await getSuggestedPriceFromLatestSales(sku, {
    percentile,
    additionalPercentiles,
    enableSupplyAnalysis,
    supplyAnalysisConfig,
    availableSinceTimestamp: categorySet?.releaseDate
      ? new Date(categorySet.releaseDate).getTime()
      : undefined,
    fetchLatestSales: options.batchApiCache
      ? options.batchApiCache.fetchLatestSales.bind(options.batchApiCache)
      : fetchLatestSalesAndRecord,
    fetchPriceHistory: options.batchApiCache
      ? options.batchApiCache.fetchPriceHistory.bind(options.batchApiCache)
      : fetchAnnualPriceHistoryAndRecord,
    fetchListingsForProduct: options.batchApiCache
      ? options.batchApiCache.fetchListingsForProduct.bind(options.batchApiCache)
      : fetchListingsForProductAndRecord,
    fetchLowestListingPrice: options.batchApiCache
      ? options.batchApiCache.fetchLowestListingPrice.bind(
          options.batchApiCache,
        )
      : undefined,
  });

  return {
    suggestedPrice: algorithmResult.suggestedPrice ?? null,
    lowestListingPrice: algorithmResult.lowestListingPrice,
    historicalSalesVelocityMs: algorithmResult.historicalSalesVelocityMs,
    estimatedTimeToSellMs: algorithmResult.estimatedTimeToSellMs,
    salesCount: algorithmResult.salesCount,
    listingsCount: algorithmResult.listingsCount,
    percentiles: algorithmResult.percentiles,
    conditionSaleRate: algorithmResult.conditionSaleRate,
    conditionNormalization: algorithmResult.conditionNormalization,
    priceEvidence: algorithmResult.priceEvidence,
  };
}
