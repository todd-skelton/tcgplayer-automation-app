/**
 * Shared convention for showing a price against market: positive means above
 * market, negative means below, and one decimal of precision decides "at market".
 */

export type MarketDeltaTone = "above" | "below" | "at" | "unavailable";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Sold relative to market as a percentage, or null when there is no positive market value. */
export function percentAboveMarket(sold: number, market: number | undefined | null): number | null {
  if (market === undefined || market === null || market <= 0) {
    return null;
  }

  return ((sold - market) / market) * 100;
}

export function getMarketDeltaTone(percent: number | null): MarketDeltaTone {
  if (percent === null) {
    return "unavailable";
  }

  const rounded = Number(percent.toFixed(1));

  if (rounded > 0) {
    return "above";
  }

  return rounded < 0 ? "below" : "at";
}

export function formatUsd(amount: number): string {
  return usdFormatter.format(amount);
}

/** "+$3.20" or "-$1.10". */
export function formatSignedUsd(amount: number): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${usdFormatter.format(Math.abs(amount))}`;
}

/** "+8.4%" or "-3.1%". */
export function formatSignedPercent(percent: number): string {
  const rounded = Number(percent.toFixed(1));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}
