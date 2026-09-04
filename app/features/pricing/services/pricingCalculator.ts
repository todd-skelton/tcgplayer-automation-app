import type {
  BuyerChoiceForecast,
  ConditionNormalizationDetail,
  ConditionRateForecast,
  PricerSku,
  PricingPercentileDetail,
  PricingConfig,
  SuggestedPriceResolver,
} from "../../../core/types/pricing";
import { forecastBuyerChoice } from "../algorithms/buyerChoiceSellTime";
import { forecastConditionRate } from "../algorithms/conditionSaleRate";
import {
  calculateInsufficientSalesFallback,
  calculateMarketplacePrice,
  getSuggestedPrice,
  type InsufficientSalesFallbackResult,
} from "./pricingService";
import { PRICING_CONSTANTS } from "../../../core/constants/pricing";
import type { PricingPolicy } from "../../../core/types/pricingPolicy";
import type { PricePoint } from "../../../integrations/tcgplayer/client/get-price-points.server";
import type { ProductDisplayInfo } from "../../../shared/services/dataEnrichmentService";
import type {
  PortfolioPricingPlan,
  PricingDecision,
} from "../domain/pricingPolicy";
import {
  netProceedsAtPrice,
  policyParameters,
  resolveValueMatchedPortfolioPlan,
  selectPricingDecision,
  toPricingCurve,
} from "../domain/pricingPolicy";
import { productLinePricingPolicy } from "../types/config";

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function createMarketplaceConstraint(
  pricePoint: PricePoint | null,
  config: Pick<PricingConfig, "minPriceMultiplier" | "minPriceConstant">,
) {
  return (candidatePrice: number) => {
    const constrained = calculateMarketplacePrice(
      candidatePrice,
      pricePoint
        ? {
            marketPrice: pricePoint.marketPrice,
            lowestPrice: pricePoint.lowestPrice,
            highestPrice: pricePoint.highestPrice,
            calculatedAt: pricePoint.calculatedAt,
          }
        : null,
      {
        minPriceMultiplier:
          config.minPriceMultiplier ?? PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER,
        minPriceConstant:
          config.minPriceConstant ?? PRICING_CONSTANTS.MIN_PRICE_CONSTANT,
      },
    );
    return {
      price: roundCurrency(constrained.marketplacePrice),
      constraint: constrained.warningMessage?.includes("minimum")
        ? ("floor" as const)
        : ("none" as const),
    };
  };
}

function policyName(policy: PricingPolicy): string {
  return policy.method === "target-horizon"
    ? "Target-horizon"
    : "Profit-per-day";
}

/** A decision priced from a reference or the current price instead of the curve. */
function fallbackDecision(
  method: PricingPolicy["method"],
  fallback: InsufficientSalesFallbackResult,
): PricingDecision {
  return {
    method,
    selectedPrice: fallback.price,
    unconstrainedPrice: fallback.price,
    constraint: fallback.basis === "current-price" ? "current-price" : "none",
    basis: fallback.basis,
    forecastStatus: "unavailable",
  };
}

/**
 * When the policy's forecast is unavailable, price as the percentile policy
 * would: the configured percentile when the curve has a point for it, else
 * the best reference price, else the current price. The forecast stays
 * unavailable so the price is reviewed rather than trusted as a forecast.
 */
function forecastFallback(
  policy: Exclude<PricingPolicy, { method: "percentile" }>,
  percentileDecision: PricingDecision | undefined,
  references: Parameters<typeof calculateInsufficientSalesFallback>[0],
): { decision: PricingDecision; warning: string } | undefined {
  const unavailable = `${policyName(policy)} forecast unavailable.`;
  const underPolicy = (decision: PricingDecision): PricingDecision => ({
    ...decision,
    method: policy.method,
    ...policyParameters(policy),
    forecastStatus: "unavailable",
  });
  if (percentileDecision?.basis === "modeled") {
    const unprofitable =
      policy.method === "profit-per-day" &&
      netProceedsAtPrice(percentileDecision.selectedPrice, policy) <= 0;
    return {
      decision: {
        ...underPolicy(percentileDecision),
        ...(unprofitable ? { unprofitable } : {}),
      },
      warning: `${unavailable} Priced at percentile ${percentileDecision.configuredPercentile} instead.`,
    };
  }
  const reference = calculateInsufficientSalesFallback(references);
  if (!reference) return undefined;
  return {
    decision: underPolicy(fallbackDecision(policy.method, reference)),
    warning: `${unavailable} ${reference.warningMessage}`,
  };
}

export interface PricingResult {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  previousPrice?: number;
  suggestedPrice?: number;
  price?: number;
  historicalSalesVelocityDays?: number;
  estimatedTimeToSellDays?: number;
  salesCountForHistorical?: number;
  listingsCountForEstimated?: number;
  percentileUsed?: number;
  percentiles?: PricingPercentileDetail[];
  productLineId?: number;
  errors?: string[];
  warnings?: string[];
  pricingDecision?: PricingDecision;
  buyerChoiceForecast?: BuyerChoiceForecast;
  conditionRateForecast?: ConditionRateForecast;
  conditionNormalization?: ConditionNormalizationDetail;
  shadowPricingDecision?: PricingDecision;
}

export interface PricingCalculationResult {
  pricedItems: PricingResult[];
  shadowPortfolioPlan?: PortfolioPricingPlan;
  stats: {
    processed: number;
    skipped: number;
    errors: number;
    warnings: number;
    processingTime: number;
  };
  aggregatedPercentiles: {
    marketPrice: { [key: string]: number };
    historicalSalesVelocity: { [key: string]: number };
    estimatedTimeToSell: { [key: string]: number };
  };
}

function getDefaultSuggestedPriceResolver(): SuggestedPriceResolver {
  return async ({
    tcgplayerId,
    percentile,
    additionalPercentiles,
    enableSupplyAnalysis,
    supplyAnalysisConfig,
    productLineId,
  }) =>
    getSuggestedPrice(
      tcgplayerId,
      percentile,
      additionalPercentiles,
      enableSupplyAnalysis,
      supplyAnalysisConfig,
      productLineId,
    );
}

export class PricingCalculator {
  async calculatePrices(
    skus: PricerSku[],
    config: PricingConfig,
    pricePointsMap: Map<number, PricePoint> = new Map(),
    source: string = "pricing",
    productDisplayMap?: Map<number, ProductDisplayInfo>,
  ): Promise<PricingCalculationResult> {
    const startTime = Date.now();
    const suggestedPriceResolver =
      config.suggestedPriceResolver ?? getDefaultSuggestedPriceResolver();
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    let warnings = 0;

    const pricedItems: PricingResult[] = [];
    const allPercentileData: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number;
      estimatedTimeToSellMs?: number;
      salesCount?: number;
      quantity: number;
    }> = [];
    const batchPercentiles = this.getBatchPercentiles(config);

    config.onProgress?.({
      current: 0,
      total: skus.length,
      status: `Starting to process ${skus.length} SKUs...`,
      processed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });

    for (let i = 0; i < skus.length && !config.isCancelled?.(); i++) {
      const pricerSku = skus[i];

      const productInfo = productDisplayMap?.get(pricerSku.sku);
      const displayName = productInfo?.productName
        ? `${productInfo.productName} (${pricerSku.sku})`
        : `SKU ${pricerSku.sku}`;

      config.onProgress?.({
        current: i + 1,
        total: skus.length,
        status: `Processing ${i + 1}/${skus.length}: ${displayName}...`,
        processed,
        skipped,
        errors,
        warnings,
      });

      try {
        if (!pricerSku.sku || pricerSku.sku <= 0) {
          skipped++;
          continue;
        }

        const productLineSettings =
          config.productLinePricingConfig?.productLineSettings[
            pricerSku.productLineId
          ];
        // Inventory Manager batches bypass skip rules because they represent
        // explicit repricing work the user queued from live pending inventory.
        if (productLineSettings?.skip && !pricerSku.bypassProductLineSkips) {
          skipped++;
          continue;
        }

        const effectivePercentile = !config.productLinePricingConfig
          ? config.percentile
          : productLineSettings && !productLineSettings.skip
            ? productLineSettings.percentile
            : config.productLinePricingConfig.defaultPercentile;

        const result = await suggestedPriceResolver({
          tcgplayerId: pricerSku.sku.toString(),
          percentile: effectivePercentile,
          additionalPercentiles: batchPercentiles.filter(
            (percentile) => percentile !== effectivePercentile,
          ),
          enableSupplyAnalysis: config.enableSupplyAnalysis,
          supplyAnalysisConfig: config.supplyAnalysisConfig,
          productLineId: pricerSku.productLineId,
        });

        const pricedItem = await this.createPricedItem(
          pricerSku,
          result,
          pricePointsMap,
          config,
        );

        pricedItem.percentileUsed = effectivePercentile;
        pricedItem.productLineId = pricerSku.productLineId;
        pricedItem.conditionNormalization = result.conditionNormalization;
        pricedItem.percentiles = result.percentiles?.map((percentile) => ({
          percentile: percentile.percentile,
          suggestedPrice: percentile.price,
          historicalSalesVelocityDays: percentile.historicalSalesVelocityMs
            ? percentile.historicalSalesVelocityMs / (24 * 60 * 60 * 1000)
            : undefined,
          estimatedTimeToSellDays: percentile.estimatedTimeToSellMs
            ? percentile.estimatedTimeToSellMs / (24 * 60 * 60 * 1000)
            : undefined,
          salesCount: percentile.salesCount,
          historyCapped: percentile.historyCapped,
          listingsCount: percentile.listingsCount,
          storeWinShare: percentile.storeWinShare,
          supplyStatus: percentile.supplyStatus,
        }));
        const curve = toPricingCurve(pricedItem.percentiles);
        const percentilePolicy = {
          method: "percentile" as const,
          percentile: effectivePercentile,
        };
        const activePolicy =
          config.policy && config.policy.method !== "percentile"
            ? productLinePricingPolicy(config.policy, productLineSettings)
            : percentilePolicy;
        const pricePoint = pricePointsMap.get(pricerSku.sku) ?? null;
        const marketplaceConstraint = createMarketplaceConstraint(
          pricePoint,
          config,
        );
        const forecastDecision = selectPricingDecision(
          curve,
          activePolicy,
          pricerSku.currentPrice,
          marketplaceConstraint,
        );
        if (activePolicy.method !== "percentile") {
          pricedItem.shadowPricingDecision =
            selectPricingDecision(
              curve,
              percentilePolicy,
              pricerSku.currentPrice,
              marketplaceConstraint,
            ) ?? pricedItem.pricingDecision;
        }
        const fallback =
          activePolicy.method !== "percentile" &&
          forecastDecision?.basis !== "modeled"
            ? forecastFallback(activePolicy, pricedItem.shadowPricingDecision, {
                marketPrice: pricePoint?.marketPrice,
                lowestListingPrice: result.lowestListingPrice,
                currentPrice: pricerSku.currentPrice,
              })
            : undefined;
        const activeDecision = fallback?.decision ?? forecastDecision;
        if (
          activePolicy.method !== "percentile" &&
          activeDecision &&
          pricedItem.errors?.length === 0
        ) {
          pricedItem.suggestedPrice =
            activeDecision.unconstrainedPrice ?? activeDecision.selectedPrice;
          pricedItem.price = activeDecision.selectedPrice;
          pricedItem.warnings = [];
          if (fallback) pricedItem.warnings.push(fallback.warning);
          if (activeDecision.unprofitable) {
            pricedItem.warnings.push(
              `No modeled price clears per-unit overhead. Listed at $${activeDecision.selectedPrice.toFixed(2)} to limit the loss.`,
            );
          }
          if (activeDecision.basis === "modeled") {
            const priceResult = calculateMarketplacePrice(
              pricedItem.suggestedPrice,
              pricePoint,
              {
                minPriceMultiplier:
                  config.minPriceMultiplier ??
                  PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER,
                minPriceConstant:
                  config.minPriceConstant ??
                  PRICING_CONSTANTS.MIN_PRICE_CONSTANT,
              },
            );
            if (priceResult.warningMessage) {
              pricedItem.warnings.push(priceResult.warningMessage);
            }
            if (priceResult.errorMessage) {
              pricedItem.errors.push(priceResult.errorMessage);
            }
          }
        }
        if (activeDecision?.basis === "modeled") {
          pricedItem.pricingDecision = activeDecision;
          pricedItem.historicalSalesVelocityDays =
            activeDecision.buyerIntervalDays;
          pricedItem.estimatedTimeToSellDays =
            activeDecision.estimatedMedianSellDays;
          pricedItem.salesCountForHistorical =
            activeDecision.qualifyingSalesCount === undefined
              ? undefined
              : Math.round(activeDecision.qualifyingSalesCount);
          pricedItem.listingsCountForEstimated =
            activeDecision.listingsCount === undefined
              ? undefined
              : Math.round(activeDecision.listingsCount);
          pricedItem.buyerChoiceForecast = forecastBuyerChoice(
            curve,
            activeDecision.selectedPrice,
          );
          pricedItem.conditionRateForecast = forecastConditionRate(
            result.conditionSaleRate,
            activeDecision.storeWinShare,
          );
        } else if (activePolicy.method !== "percentile" && activeDecision) {
          pricedItem.pricingDecision = activeDecision;
        } else if (
          activePolicy.method !== "percentile" &&
          pricedItem.pricingDecision
        ) {
          pricedItem.pricingDecision = {
            ...pricedItem.pricingDecision,
            method: activePolicy.method,
            configuredPercentile: undefined,
            ...policyParameters(activePolicy),
          };
        } else if (pricedItem.pricingDecision) {
          pricedItem.pricingDecision.configuredPercentile = effectivePercentile;
        } else if (
          pricedItem.suggestedPrice !== undefined &&
          pricedItem.price !== undefined
        ) {
          pricedItem.pricingDecision = {
            method: "percentile",
            selectedPrice: roundCurrency(pricedItem.price),
            unconstrainedPrice: roundCurrency(pricedItem.suggestedPrice),
            configuredPercentile: effectivePercentile,
            constraint:
              Math.abs(pricedItem.price - pricedItem.suggestedPrice) >= 0.005
                ? "floor"
                : "none",
            basis: "modeled",
            forecastStatus: "unavailable",
          };
        }

        if (pricedItem.errors && pricedItem.errors.length > 0) {
          errors++;
        } else if (pricedItem.warnings && pricedItem.warnings.length > 0) {
          warnings++;
          processed++; // Items with warnings are still successfully processed
        } else {
          processed++;
        }

        if (result.percentiles && Array.isArray(result.percentiles)) {
          const quantity =
            (pricerSku.quantity || 0) + (pricerSku.addToQuantity || 0);
          result.percentiles.forEach((p) => {
            allPercentileData.push({
              percentile: p.percentile,
              price: p.price,
              historicalSalesVelocityMs: p.historicalSalesVelocityMs,
              estimatedTimeToSellMs: p.estimatedTimeToSellMs,
              salesCount: p.salesCount,
              quantity,
            });
          });
        }

        pricedItems.push(pricedItem);
      } catch (error: any) {
        const errorItem: PricingResult = {
          sku: pricerSku.sku,
          quantity: pricerSku.quantity,
          addToQuantity: pricerSku.addToQuantity,
          previousPrice: pricerSku.currentPrice,
          errors: [error?.message || "Processing error"],
        };
        pricedItems.push(errorItem);
        errors++;
      }
    }

    if (config.isCancelled?.()) {
      throw new Error("Processing cancelled by user");
    }

    config.onProgress?.({
      current: skus.length,
      total: skus.length,
      status: "Pricing calculation complete!",
      processed,
      skipped,
      errors,
      warnings,
    });

    const processingTime = Date.now() - startTime;

    const aggregatedPercentiles =
      this.calculateAggregatedPercentiles(allPercentileData);

    const sourceSkusById = new Map(skus.map((sku) => [sku.sku, sku]));
    const portfolioItems = pricedItems.map((item) => {
      const sourceSku = sourceSkusById.get(item.sku);
      const pricePoint = pricePointsMap.get(item.sku) ?? null;
      return {
        sku: item.sku,
        currentPrice: sourceSku?.currentPrice,
        curve: toPricingCurve(item.percentiles),
        constraintIdentity: [
          pricePoint?.marketPrice ?? 0,
          config.minPriceMultiplier ?? PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER,
          config.minPriceConstant ?? PRICING_CONSTANTS.MIN_PRICE_CONSTANT,
        ].join(":"),
        applyConstraint: createMarketplaceConstraint(pricePoint, config),
      };
    });
    const hasValueMatchBaseline = portfolioItems.some(
      (item) => (item.currentPrice ?? 0) > 0,
    );
    const shadow =
      (config.policy?.method ?? "percentile") === "percentile" &&
      hasValueMatchBaseline
        ? resolveValueMatchedPortfolioPlan(portfolioItems, { cohortId: source })
        : undefined;

    if (shadow) {
      for (const item of pricedItems) {
        item.shadowPricingDecision = shadow.decisionsBySku.get(item.sku);
      }
    }

    return {
      pricedItems,
      shadowPortfolioPlan: shadow?.plan,
      stats: {
        processed,
        skipped,
        errors,
        warnings,
        processingTime,
      },
      aggregatedPercentiles,
    };
  }

  private getBatchPercentiles(config: PricingConfig): number[] {
    const percentiles = new Set<number>([config.percentile]);

    const productLinePricingConfig = config.productLinePricingConfig;
    if (!productLinePricingConfig) {
      return [...percentiles].sort((a, b) => a - b);
    }

    percentiles.add(productLinePricingConfig.defaultPercentile);

    for (const settings of Object.values(
      productLinePricingConfig.productLineSettings,
    )) {
      if (!settings.skip) {
        percentiles.add(settings.percentile);
      }
    }

    return [...percentiles].sort((a, b) => a - b);
  }

  private calculateAggregatedPercentiles(
    percentileData: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number;
      estimatedTimeToSellMs?: number;
      salesCount?: number;
      quantity: number;
    }>,
  ): {
    marketPrice: { [key: string]: number };
    historicalSalesVelocity: { [key: string]: number };
    estimatedTimeToSell: { [key: string]: number };
  } {
    const aggregated = {
      marketPrice: {} as { [key: string]: number },
      historicalSalesVelocity: {} as { [key: string]: number },
      estimatedTimeToSell: {} as { [key: string]: number },
    };

    const percentileGroups: { [key: number]: typeof percentileData } = {};

    percentileData.forEach((item) => {
      if (!percentileGroups[item.percentile]) {
        percentileGroups[item.percentile] = [];
      }
      percentileGroups[item.percentile].push(item);
    });

    Object.entries(percentileGroups).forEach(([percentile, items]) => {
      let totalValue = 0;
      let totalQuantity = 0;

      items.forEach((item) => {
        const quantity = item.quantity || 1;
        totalValue += item.price * quantity;
        totalQuantity += quantity;
      });

      aggregated.marketPrice[`${percentile}th`] = totalValue;

      if (totalQuantity > 0) {
        const historicalVelocityValues = items
          .map((item) => {
            const timeMs = item.historicalSalesVelocityMs;
            return timeMs ? timeMs / (24 * 60 * 60 * 1000) : undefined; // Convert ms to days
          })
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);

        if (historicalVelocityValues.length > 0) {
          const midIndex = Math.floor(historicalVelocityValues.length / 2);
          const median =
            historicalVelocityValues.length % 2 === 0
              ? (historicalVelocityValues[midIndex - 1] +
                  historicalVelocityValues[midIndex]) /
                2
              : historicalVelocityValues[midIndex];

          aggregated.historicalSalesVelocity[`${percentile}th`] = median;
        }

        const marketAdjustedValues = items
          .map((item) => {
            const timeMs = item.estimatedTimeToSellMs;
            return timeMs ? timeMs / (24 * 60 * 60 * 1000) : undefined; // Convert ms to days
          })
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);

        if (marketAdjustedValues.length > 0) {
          const midIndex = Math.floor(marketAdjustedValues.length / 2);
          const median =
            marketAdjustedValues.length % 2 === 0
              ? (marketAdjustedValues[midIndex - 1] +
                  marketAdjustedValues[midIndex]) /
                2
              : marketAdjustedValues[midIndex];

          aggregated.estimatedTimeToSell[`${percentile}th`] = median;
        }
      }
    });

    return aggregated;
  }

  private async createPricedItem(
    pricerSku: PricerSku,
    result: any,
    pricePointsMap: Map<number, PricePoint> = new Map(),
    config: Pick<PricingConfig, "minPriceMultiplier" | "minPriceConstant"> = {},
  ): Promise<PricingResult> {
    const pricedItem: PricingResult = {
      sku: pricerSku.sku,
      quantity: pricerSku.quantity,
      addToQuantity: pricerSku.addToQuantity,
      previousPrice: pricerSku.currentPrice,
      errors: [],
      warnings: [],
    };

    if (result.error) {
      pricedItem.errors?.push(result.error);
      return pricedItem;
    }

    const pricePoint = pricePointsMap.get(pricerSku.sku) || null;

    if (result.suggestedPrice !== null && result.suggestedPrice !== undefined) {
      pricedItem.suggestedPrice = result.suggestedPrice;

      const { marketplacePrice, warningMessage, errorMessage } =
        calculateMarketplacePrice(
          result.suggestedPrice,
          pricePoint
            ? {
                marketPrice: pricePoint.marketPrice,
                lowestPrice: pricePoint.lowestPrice,
                highestPrice: pricePoint.highestPrice,
                calculatedAt: pricePoint.calculatedAt,
              }
            : null,
          {
            minPriceMultiplier:
              config.minPriceMultiplier ??
              PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER,
            minPriceConstant:
              config.minPriceConstant ?? PRICING_CONSTANTS.MIN_PRICE_CONSTANT,
          },
        );

      pricedItem.price = roundCurrency(marketplacePrice);

      if (warningMessage) {
        pricedItem.warnings?.push(warningMessage);
      }

      if (errorMessage) {
        pricedItem.errors?.push(errorMessage);
      }
    } else {
      const fallback = calculateInsufficientSalesFallback({
        marketPrice: pricePoint?.marketPrice,
        lowestListingPrice: result.lowestListingPrice,
        currentPrice: pricerSku.currentPrice,
      });

      if (fallback) {
        pricedItem.suggestedPrice = fallback.price;
        pricedItem.price = fallback.price;
        pricedItem.pricingDecision = fallbackDecision("percentile", fallback);
        pricedItem.warnings?.push(fallback.warningMessage);
      }
    }

    if (result.historicalSalesVelocityMs) {
      pricedItem.historicalSalesVelocityDays =
        result.historicalSalesVelocityMs / (24 * 60 * 60 * 1000);
    }

    if (result.estimatedTimeToSellMs) {
      pricedItem.estimatedTimeToSellDays =
        result.estimatedTimeToSellMs / (24 * 60 * 60 * 1000);
    }

    if (result.salesCount !== undefined) {
      pricedItem.salesCountForHistorical = result.salesCount;
    }

    if (result.listingsCount !== undefined) {
      pricedItem.listingsCountForEstimated = result.listingsCount;
    }

    return pricedItem;
  }
}
