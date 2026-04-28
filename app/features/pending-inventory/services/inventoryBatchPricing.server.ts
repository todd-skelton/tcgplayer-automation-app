import type {
  PricedSku,
  ProcessingProgress,
  ProcessingSummary,
  PricerSku,
  SuggestedPriceResolver,
} from "~/core/types/pricing";
import {
  inventoryBatchesRepository,
  setProductsRepository,
  skusRepository,
} from "~/core/db";
import { createDisplayName } from "~/core/utils/displayNameUtils";
import type { PricePoint } from "~/integrations/tcgplayer/client/get-price-points.server";
import { getPricePoints } from "~/integrations/tcgplayer/client/get-price-points.server";
import { PricingCalculator } from "~/features/pricing/services/pricingCalculator";
import { PricingBatchApiCache } from "~/features/pricing/services/pricingBatchApiCache.server";
import { resolveSuggestedPrice } from "~/features/pricing/services/suggestedPriceResolver.server";
import type { ProductDisplayInfo } from "~/shared/services/dataEnrichmentService";
import type {
  InventoryBatchItem,
  InventoryBatchPricingMode,
} from "../types/inventoryBatch";
import type { ServerPricingConfig } from "~/features/pricing/types/config";

export interface InventoryBatchPricingExecutionResult {
  pricedSkus: PricedSku[];
  summary: ProcessingSummary;
  finalProgress: ProcessingProgress;
}

interface ExecuteInventoryBatchPricingJobOptions {
  batchNumber: number;
  mode: InventoryBatchPricingMode;
  config: ServerPricingConfig;
  onProgress?: (progress: ProcessingProgress) => void;
  isCancelled?: () => boolean;
}

function throwIfCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) {
    throw new Error("Processing cancelled by user");
  }
}

async function loadProductDisplayMap(
  items: InventoryBatchItem[],
): Promise<Map<number, ProductDisplayInfo>> {
  const skuMap = new Map<number, ProductDisplayInfo>();
  const itemsBySku = new Map(items.map((item) => [item.sku, item]));
  const productIds = [...new Set(items.map((item) => item.productId))];
  const setProducts = await setProductsRepository.findByProductIds(productIds);
  const setProductsByProductId = new Map(
    setProducts.map((setProduct) => [setProduct.productId, setProduct]),
  );

  const skuIdsByProductLine = new Map<number, number[]>();
  for (const item of items) {
    const existing = skuIdsByProductLine.get(item.productLineId) ?? [];
    existing.push(item.sku);
    skuIdsByProductLine.set(item.productLineId, existing);
  }

  for (const [productLineId, skuIds] of skuIdsByProductLine) {
    const skus = await skusRepository.findBySkuIds(productLineId, skuIds);
    for (const sku of skus) {
      const item = itemsBySku.get(sku.sku);
      const setProduct = item
        ? setProductsByProductId.get(item.productId)
        : setProductsByProductId.get(sku.productId);

      skuMap.set(sku.sku, {
        sku: sku.sku,
        productLine: sku.productLineName,
        setName: sku.setName,
        productName: createDisplayName(
          sku.productName,
          setProduct?.number ?? null,
          sku.rarityName,
          sku.variant,
          sku.language,
        ),
        condition: sku.condition,
        variant: sku.variant,
      });
    }
  }

  return skuMap;
}

function createPricePointMap(pricePoints: PricePoint[]): Map<number, PricePoint> {
  return new Map(pricePoints.map((pricePoint) => [pricePoint.skuId, pricePoint]));
}

function enrichPricedSkus(
  pricedItems: Awaited<ReturnType<PricingCalculator["calculatePrices"]>>["pricedItems"],
  productDisplayMap: Map<number, ProductDisplayInfo>,
  pricePointsMap: Map<number, PricePoint>,
): PricedSku[] {
  return pricedItems.map((pricedItem) => {
    const productInfo = productDisplayMap.get(pricedItem.sku);
    const pricePoint = pricePointsMap.get(pricedItem.sku);

    return {
      sku: pricedItem.sku,
      productLineId: pricedItem.productLineId,
      quantity: pricedItem.quantity,
      addToQuantity: pricedItem.addToQuantity,
      previousPrice: pricedItem.previousPrice,
      suggestedPrice: pricedItem.suggestedPrice,
      price: pricedItem.price,
      historicalSalesVelocityDays: pricedItem.historicalSalesVelocityDays,
      estimatedTimeToSellDays: pricedItem.estimatedTimeToSellDays,
      salesCountForHistorical: pricedItem.salesCountForHistorical,
      listingsCountForEstimated: pricedItem.listingsCountForEstimated,
      percentileUsed: pricedItem.percentileUsed,
      percentiles: pricedItem.percentiles,
      errors: pricedItem.errors,
      warnings: pricedItem.warnings,
      productLine: productInfo?.productLine,
      setName: productInfo?.setName,
      productName: productInfo?.productName,
      condition: productInfo?.condition,
      variant: productInfo?.variant,
      lowestSalePrice: pricePoint?.lowestPrice,
      highestSalePrice: pricePoint?.highestPrice,
      saleCount: pricePoint?.priceCount || 0,
      tcgMarketPrice: pricePoint?.marketPrice,
    } satisfies PricedSku;
  });
}

function buildSummary(
  batchNumber: number,
  sourceSkus: PricerSku[],
  invalidCount: number,
  pricingResult: Awaited<ReturnType<PricingCalculator["calculatePrices"]>>,
  enrichedSkus: PricedSku[],
  productDisplayMap: Map<number, ProductDisplayInfo>,
  config: ServerPricingConfig,
  processingTime: number,
): ProcessingSummary {
  const skippedRows = invalidCount + pricingResult.stats.skipped;
  const processedRows = pricingResult.stats.processed;

  const productLineBreakdown: Record<
    string,
    {
      count: number;
      percentileUsed: number;
      skipped: boolean;
      totalValue: number;
    }
  > = {};

  for (const sku of enrichedSkus) {
    const productLineName = sku.productLine || "Unknown";
    const percentileUsed =
      sku.percentileUsed || config.productLinePricing.defaultPercentile;
    const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
    const value = (sku.suggestedPrice || 0) * combinedQty;

    if (!productLineBreakdown[productLineName]) {
      productLineBreakdown[productLineName] = {
        count: 0,
        percentileUsed,
        skipped: false,
        totalValue: 0,
      };
    }

    productLineBreakdown[productLineName].count++;
    productLineBreakdown[productLineName].totalValue += value;
  }

  for (const [productLineIdText, settings] of Object.entries(
    config.productLinePricing.productLineSettings,
  )) {
    if (!settings.skip) {
      continue;
    }

    const productLineId = Number(productLineIdText);
    const skippedCount = sourceSkus.filter(
      (sku) => sku.productLineId === productLineId && !sku.bypassProductLineSkips,
    ).length;

    if (skippedCount === 0) {
      continue;
    }

    const productLineName =
      sourceSkus
        .map((sku) => productDisplayMap.get(sku.sku)?.productLine)
        .find(Boolean) || `ProductLine-${productLineId}`;

    productLineBreakdown[productLineName] = {
      count: skippedCount,
      percentileUsed: 0,
      skipped: true,
      totalValue: 0,
    };
  }

  return {
    totalRows: sourceSkus.length + invalidCount,
    processedRows,
    skippedRows,
    errorRows: pricingResult.stats.errors,
    warningRows: pricingResult.stats.warnings,
    successRate:
      sourceSkus.length + invalidCount > 0
        ? (processedRows / (sourceSkus.length + invalidCount)) * 100
        : 0,
    processingTime,
    fileName: `inventory-batch-${batchNumber}`,
    percentileUsed: config.productLinePricing.defaultPercentile,
    totalQuantity: enrichedSkus.reduce(
      (sum, sku) => sum + (sku.quantity || 0),
      0,
    ),
    totalAddQuantity: enrichedSkus.reduce(
      (sum, sku) => sum + (sku.addToQuantity || 0),
      0,
    ),
    totals: {
      marketPrice: enrichedSkus.reduce((sum, sku) => {
        const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
        return sum + (sku.tcgMarketPrice || 0) * combinedQty;
      }, 0),
      lowPrice: enrichedSkus.reduce((sum, sku) => {
        const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
        return sum + (sku.lowestSalePrice || 0) * combinedQty;
      }, 0),
      marketplacePrice: enrichedSkus.reduce((sum, sku) => {
        const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
        return sum + (sku.price || 0) * combinedQty;
      }, 0),
      percentiles: pricingResult.aggregatedPercentiles.marketPrice,
    },
    totalsWithMarket: {
      marketPrice: enrichedSkus.reduce((sum, sku) => {
        if (!sku.tcgMarketPrice) {
          return sum;
        }

        const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
        return sum + sku.tcgMarketPrice * combinedQty;
      }, 0),
      percentiles: pricingResult.aggregatedPercentiles.marketPrice,
      quantityWithMarket: enrichedSkus
        .filter((sku) => sku.tcgMarketPrice)
        .reduce(
          (sum, sku) => sum + (sku.quantity || 0) + (sku.addToQuantity || 0),
          0,
        ),
    },
    medianDaysToSell: {
      historicalSalesVelocity: 0,
      percentiles: pricingResult.aggregatedPercentiles.historicalSalesVelocity,
      marketAdjustedPercentiles:
        pricingResult.aggregatedPercentiles.estimatedTimeToSell,
    },
    productLineBreakdown:
      Object.keys(productLineBreakdown).length > 0
        ? productLineBreakdown
        : undefined,
  };
}

export async function executeInventoryBatchPricingJob({
  batchNumber,
  mode,
  config,
  onProgress,
  isCancelled,
}: ExecuteInventoryBatchPricingJobOptions): Promise<InventoryBatchPricingExecutionResult> {
  const startTime = Date.now();
  const pricingCalculator = new PricingCalculator();
  const sourceScope = mode === "errors" ? "errors" : "all";

  const emitProgress = (progress: ProcessingProgress) => {
    onProgress?.(progress);
  };

  const validationStartTime = Date.now();
  emitProgress({
    current: 1,
    total: 6,
    status: "Loading inventory batch items...",
    processed: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
    phase: "Data Validation",
    phaseStartTime: validationStartTime,
  });

  const batch = await inventoryBatchesRepository.findByBatchNumber(batchNumber);
  if (!batch) {
    throw new Error(`Batch ${batchNumber} not found`);
  }

  const items = await inventoryBatchesRepository.findItems(batchNumber, sourceScope);
  throwIfCancelled(isCancelled);

  const bypassProductLineSkips = batch.sourceType === "pending_inventory";

  const sourceSkus = items
    .filter(
      (item) =>
        item.sku > 0 && item.totalQuantity + item.addToQuantity > 0,
    )
    .map(
      (item): PricerSku => ({
        sku: item.sku,
        quantity: item.totalQuantity > 0 ? item.totalQuantity : undefined,
        addToQuantity: item.addToQuantity > 0 ? item.addToQuantity : undefined,
        currentPrice: item.currentPrice ?? undefined,
        bypassProductLineSkips,
        productLineId: item.productLineId,
        setId: item.setId,
        productId: item.productId,
      }),
    );
  const invalidCount = items.length - sourceSkus.length;

  if (sourceSkus.length === 0) {
    throw new Error(
      mode === "errors"
        ? "No manual review rows are available to reprice"
        : "No batch items are available to price",
    );
  }

  const productDisplayMap = await loadProductDisplayMap(items);
  throwIfCancelled(isCancelled);

  emitProgress({
    current: 2,
    total: 6,
    status: `Validated ${sourceSkus.length} SKUs, fetching price points...`,
    processed: 0,
    skipped: invalidCount,
    errors: 0,
    warnings: 0,
    phase: "Preparing Price Data",
    phaseStartTime: Date.now(),
  });

  const pricePointStartTime = Date.now();
  emitProgress({
    current: 3,
    total: 6,
    status: "Fetching price points...",
    processed: 0,
    skipped: invalidCount,
    errors: 0,
    warnings: 0,
    phase: "Fetching Price Data",
    phaseStartTime: pricePointStartTime,
    subProgress: {
      current: 0,
      total: sourceSkus.length,
      status: "Requesting latest price points...",
    },
  });

  const pricePoints = await getPricePoints({
    skuIds: sourceSkus.map((sku) => sku.sku),
  });
  const pricePointsMap = createPricePointMap(pricePoints);
  throwIfCancelled(isCancelled);

  emitProgress({
    current: 3,
    total: 6,
    status: "Price points fetched successfully!",
    processed: 0,
    skipped: invalidCount,
    errors: 0,
    warnings: 0,
    phase: "Fetching Price Data",
    phaseStartTime: pricePointStartTime,
    subProgress: {
      current: sourceSkus.length,
      total: sourceSkus.length,
      status: "Price point fetch complete",
    },
  });

  const pricingStartTime = Date.now();
  const batchApiCache = new PricingBatchApiCache();
  const resolveSuggestedPriceWithBatchCache: SuggestedPriceResolver = (input) =>
    resolveSuggestedPrice(input, { batchApiCache });
  let latestPricingProgress: ProcessingProgress = {
    current: 4,
    total: 6,
    status: "Calculating pricing...",
    processed: 0,
    skipped: invalidCount,
    errors: 0,
    warnings: 0,
    phase: "Calculating Prices",
    phaseStartTime: pricingStartTime,
  };

  emitProgress(latestPricingProgress);

  const pricingResult = await pricingCalculator.calculatePrices(
    sourceSkus,
    {
      percentile: config.productLinePricing.defaultPercentile,
      enableSupplyAnalysis: config.supplyAnalysis.enableSupplyAnalysis,
      supplyAnalysisConfig: {
        maxListingsPerSku: config.supplyAnalysis.maxListingsPerSku,
        includeUnverifiedSellers: config.supplyAnalysis.includeUnverifiedSellers,
      },
      productLinePricingConfig: config.productLinePricing,
      suggestedPriceResolver: resolveSuggestedPriceWithBatchCache,
      isCancelled,
      onProgress: (progress) => {
        latestPricingProgress = {
          current: 4,
          total: 6,
          status: "Calculating pricing...",
          processed: progress.processed,
          skipped: invalidCount + progress.skipped,
          errors: progress.errors,
          warnings: progress.warnings,
          phase: "Calculating Prices",
          phaseStartTime: pricingStartTime,
          subProgress: {
            current: progress.current,
            total: progress.total,
            status: progress.status,
          },
        };
        emitProgress(latestPricingProgress);
      },
    },
    pricePointsMap,
    `inventory-batch-${batchNumber}`,
    productDisplayMap,
  );
  throwIfCancelled(isCancelled);

  const enrichmentStartTime = Date.now();
  emitProgress({
    current: 5,
    total: 6,
    status: "Enriching pricing data for display...",
    processed: pricingResult.stats.processed,
    skipped: invalidCount + pricingResult.stats.skipped,
    errors: pricingResult.stats.errors,
    warnings: pricingResult.stats.warnings,
    phase: "Enriching Display Data",
    phaseStartTime: enrichmentStartTime,
  });

  const enrichedSkus = enrichPricedSkus(
    pricingResult.pricedItems,
    productDisplayMap,
    pricePointsMap,
  );
  const processingTime = Date.now() - startTime;
  const summary = buildSummary(
    batchNumber,
    sourceSkus,
    invalidCount,
    pricingResult,
    enrichedSkus,
    productDisplayMap,
    config,
    processingTime,
  );

  const finalProgress: ProcessingProgress = {
    current: 6,
    total: 6,
    status: "Complete",
    processed: pricingResult.stats.processed,
    skipped: invalidCount + pricingResult.stats.skipped,
    errors: pricingResult.stats.errors,
    warnings: pricingResult.stats.warnings,
    phase: "Complete",
  };

  emitProgress(finalProgress);

  return {
    pricedSkus: enrichedSkus,
    summary,
    finalProgress,
  };
}
