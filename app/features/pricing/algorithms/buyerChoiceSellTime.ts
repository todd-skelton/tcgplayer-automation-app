import type { BuyerChoiceForecast } from "~/core/types/pricing";
import type { PricingCurvePoint } from "~/core/types/pricingPolicy";

/**
 * Sell-time forecast from how buyers actually purchase, calibrated to
 * realized sales. A listing's daily sale rate is the card's sale rate at any
 * price, softened by how many sellers compete for it, and scaled by the
 * card's share of what the buyer pays once the fixed cost of a purchase is
 * included:
 *
 *   rate = e^logDailyRate · interval^-demand · (sellers + 1)^-competition
 *          · (price / (price + purchaseFixedCost))^effectivePrice
 *
 * The elasticities sit below one because part of every card's sales arrive
 * through the store rather than through a price contest for that card. The
 * listed price enters as the size of the purchase, not as a lever: the model
 * has no within-card price response, so it forecasts one listing at its price
 * and must not be read along a curve.
 */
export interface BuyerChoiceCalibration {
  /** Identifies the fit, so stored forecasts from different fits stay apart. */
  name: string;
  /** Log daily sale rate at one sale a day, no competitors, and no fixed cost. */
  logDailyRate: number;
  /** Elasticity of the rate to the card's interval between sales at any price. */
  demandElasticity: number;
  /** Elasticity of the rate to the number of competing sellers plus one. */
  competitionElasticity: number;
  /** Elasticity of the rate to the card's share of the buyer's effective price. */
  effectivePriceElasticity: number;
  /** Dollars a buyer pays beyond the card, as assumed by the fit. */
  purchaseFixedCost: number;
}

/**
 * Fitted on 1,196 listings priced 2026-08-11 to 13 against their sales over
 * the following 21 days, with the inputs read from the curve exactly as
 * buyerChoiceInputs reads them and the store's small-order shipping fee as
 * the fixed cost of a purchase. Those curves counted competing sellers in
 * the listing's own condition; since pooled-supply-v1 the curve counts
 * sellers in every condition of the product, so this fit reads a larger
 * competitor count than it was trained on until it is refit on pooled curves.
 */
export const BUYER_CHOICE_CALIBRATION: BuyerChoiceCalibration = {
  name: "2026-08-11-cohort",
  logDailyRate: -3.5172,
  demandElasticity: 0.4478,
  competitionElasticity: 0.1997,
  effectivePriceElasticity: 0.8246,
  purchaseFixedCost: 1.49,
};

export interface BuyerChoiceInputs {
  /** Days between the card's sales at the bottom of the curve, so at any price. */
  buyerIntervalDays: number;
  /** Sellers competing anywhere on the curve. */
  competingSellers: number;
}

/** The card facts the model was fitted on, read from a pricing curve. */
export function buyerChoiceInputs(
  curve: readonly PricingCurvePoint[],
): BuyerChoiceInputs | undefined {
  const bottom = [...curve]
    .sort((left, right) => left.percentile - right.percentile)
    .find((point) => (point.buyerIntervalDays ?? 0) > 0);
  const sellerCounts = curve
    .map((point) => point.listingsCount)
    .filter((count): count is number => count !== undefined);
  if (!bottom || sellerCounts.length === 0) return undefined;
  return {
    buyerIntervalDays: bottom.buyerIntervalDays!,
    competingSellers: Math.max(...sellerCounts),
  };
}

/** Median days for one listing to sell, or undefined when an input is unusable. */
export function estimateBuyerChoiceSellDays(
  { buyerIntervalDays, competingSellers }: BuyerChoiceInputs,
  listedPrice: number,
  calibration: BuyerChoiceCalibration = BUYER_CHOICE_CALIBRATION,
): number | undefined {
  if (
    !(Number.isFinite(buyerIntervalDays) && buyerIntervalDays > 0) ||
    !(Number.isFinite(competingSellers) && competingSellers >= 0) ||
    !(Number.isFinite(listedPrice) && listedPrice > 0)
  ) {
    return undefined;
  }
  const logRate =
    calibration.logDailyRate -
    calibration.demandElasticity * Math.log(buyerIntervalDays) -
    calibration.competitionElasticity * Math.log(competingSellers + 1) +
    calibration.effectivePriceElasticity *
      Math.log(listedPrice / (listedPrice + calibration.purchaseFixedCost));
  return Math.LN2 / Math.exp(logRate);
}

/** The forecast for a listing at its price, when its curve supports one. */
export function forecastBuyerChoice(
  curve: readonly PricingCurvePoint[],
  listedPrice: number,
  calibration: BuyerChoiceCalibration = BUYER_CHOICE_CALIBRATION,
): BuyerChoiceForecast | undefined {
  const inputs = buyerChoiceInputs(curve);
  const medianSellDays =
    inputs && estimateBuyerChoiceSellDays(inputs, listedPrice, calibration);
  return medianSellDays === undefined
    ? undefined
    : { medianSellDays, calibration: calibration.name };
}
