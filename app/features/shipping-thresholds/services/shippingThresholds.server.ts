import { shippingThresholdEvidenceRepository } from "~/core/db";
import type { ShippingCostModel } from "~/core/types/shippingThresholds";
import {
  normalizeShippingThresholdSnapSettings,
  snapsShippingThresholds,
  type PricingConfigSettings,
  type ShippingThresholdSnapSettings,
} from "~/features/pricing/types/config";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";
import {
  MINIMUM_NEARBY_BASKETS,
  basketsNear,
  expectedShippingCost,
  learnShippingCostModel,
} from "../domain/shippingCostModel";
import { shippingThresholdSnapOutcomes, type ThresholdOutcome } from "../domain/snapOutcomes";

const DAY_MS = 86_400_000;
/** Pricing runs reuse a learned model this long before learning it again. */
const MODEL_REUSE_MS = 60 * 60 * 1000;

const learnedModels = new Map<string, { learnedAt: number; model: Promise<ShippingCostModel> }>();

async function shippingSellerKey(): Promise<string> {
  return (await getShippingExportConfig()).defaultSellerKey.trim();
}

/** Learns shipping costs from the seller's orders over the trailing window. */
export async function learnRecentShippingCosts(
  sellerKey: string,
  evidenceWindowDays: number,
  now = new Date(),
): Promise<ShippingCostModel> {
  const orders = await shippingThresholdEvidenceRepository.findShippedOrders(
    sellerKey,
    new Date(now.getTime() - evidenceWindowDays * DAY_MS),
  );
  return learnShippingCostModel(orders, { learnedAt: now.toISOString(), evidenceWindowDays });
}

/**
 * The shipping cost model pricing snaps with, relearned at most hourly. Pricing
 * goes ahead without snaps when the policy is not profit per day, snaps are
 * off, no shipping seller is configured, or the model cannot be learned.
 */
export async function shippingCostModelForPricing(
  pricing: PricingConfigSettings,
  now = new Date(),
): Promise<ShippingCostModel | undefined> {
  if (!snapsShippingThresholds(pricing)) return undefined;
  const settings = normalizeShippingThresholdSnapSettings(pricing.shippingThresholdSnaps);
  try {
    const sellerKey = await shippingSellerKey();
    if (!sellerKey) return undefined;
    const key = `${sellerKey}:${settings.evidenceWindowDays}`;
    const cached = learnedModels.get(key);
    if (cached && now.getTime() - cached.learnedAt < MODEL_REUSE_MS) return await cached.model;
    const model = learnRecentShippingCosts(sellerKey, settings.evidenceWindowDays, now);
    learnedModels.set(key, { learnedAt: now.getTime(), model });
    return await model;
  } catch (error) {
    learnedModels.clear();
    console.error("Shipping cost model could not be learned; pricing without threshold snaps.", error);
    return undefined;
  }
}

/** Expected shipping cost per unit one cent under a threshold and at it. */
export interface ThresholdShippingCost {
  threshold: number;
  snapPriceShippingCost?: number;
  thresholdShippingCost?: number;
  /** Units sold between half and twice the threshold; snaps need at least the minimum. */
  basketCount: number;
}

export interface ShippingThresholdReport {
  sellerKey: string;
  settings: ShippingThresholdSnapSettings;
  costModel: Omit<ShippingCostModel, "baskets"> & { basketCount: number };
  thresholdCosts: ThresholdShippingCost[];
  outcomeWindowDays: number;
  outcomes: ThresholdOutcome[];
}

const roundCurrency = (value: number): number => Math.round(value * 100) / 100;

/** Expected shipping costs at each threshold, or only the basket count when too few sold nearby to snap. */
export function thresholdShippingCosts(
  model: ShippingCostModel,
  thresholds: readonly number[],
  overheadRate: number,
): ThresholdShippingCost[] {
  return thresholds.map((threshold) => {
    const baskets = basketsNear(model, threshold);
    const cost = (price: number): number | undefined =>
      baskets.length < MINIMUM_NEARBY_BASKETS
        ? undefined
        : roundCurrency(expectedShippingCost(model.tiers, baskets, price, overheadRate));
    return {
      threshold,
      snapPriceShippingCost: cost(threshold - 0.01),
      thresholdShippingCost: cost(threshold),
      basketCount: baskets.length,
    };
  });
}

/** The learned shipping costs and what snapping has done over the outcome window. */
export async function loadShippingThresholdReport(
  settings: ShippingThresholdSnapSettings,
  overheadRate: number,
  outcomeWindowDays: number,
  now = new Date(),
): Promise<ShippingThresholdReport> {
  const sellerKey = await shippingSellerKey();
  if (!sellerKey) throw new Error("Set the default seller in shipping export settings.");
  const since = new Date(now.getTime() - outcomeWindowDays * DAY_MS);
  const [model, orders, publications] = await Promise.all([
    learnRecentShippingCosts(sellerKey, settings.evidenceWindowDays, now),
    shippingThresholdEvidenceRepository.findShippedOrders(sellerKey, since),
    shippingThresholdEvidenceRepository.findSnapPublications(sellerKey, since),
  ]);
  const { baskets, ...summary } = model;
  return {
    sellerKey,
    settings,
    costModel: { ...summary, basketCount: baskets.length },
    thresholdCosts: thresholdShippingCosts(model, settings.thresholds, overheadRate),
    outcomeWindowDays,
    outcomes: shippingThresholdSnapOutcomes({
      thresholds: settings.thresholds,
      snapRange: settings.snapRange,
      overheadRate,
      orders,
      publications,
    }),
  };
}
