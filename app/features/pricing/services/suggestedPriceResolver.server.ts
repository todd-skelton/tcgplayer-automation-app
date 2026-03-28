import type {
  SuggestedPriceResolverInput,
  SuggestedPriceResult,
} from "~/core/types/pricing";
import { productsRepository, skusRepository } from "~/core/db";
import { getSuggestedPriceFromLatestSales } from "../algorithms/getSuggestedPriceFromLatestSales";

export async function resolveSuggestedPrice({
  tcgplayerId,
  percentile = 65,
  enableSupplyAnalysis = false,
  supplyAnalysisConfig = {},
  productLineId,
}: SuggestedPriceResolverInput): Promise<SuggestedPriceResult> {
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

  const product = await productsRepository.findByProductId(
    sku.productId,
    sku.productLineId,
  );

  if (!product) {
    return {
      error: `Product ${sku.productId} not found for SKU ${skuId}`,
      suggestedPrice: null,
    };
  }

  const algorithmResult = await getSuggestedPriceFromLatestSales(sku, {
    percentile,
    enableSupplyAnalysis,
    supplyAnalysisConfig,
  });

  return {
    suggestedPrice: algorithmResult.suggestedPrice ?? null,
    historicalSalesVelocityMs: algorithmResult.historicalSalesVelocityMs,
    estimatedTimeToSellMs: algorithmResult.estimatedTimeToSellMs,
    salesCount: algorithmResult.salesCount,
    listingsCount: algorithmResult.listingsCount,
    percentiles: algorithmResult.percentiles,
  };
}
