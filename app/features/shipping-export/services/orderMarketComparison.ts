import { getMarketDeltaTone, percentAboveMarket } from "~/core/utils/marketDelta";
import type {
  OrderLineItem,
  ShipmentToOrderMap,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";
import { getOrderNumbersForShipmentReference } from "./shippingExportUtils";

/**
 * How a set of sold lines compares to the current TCGPlayer market.
 *
 * Totals that include the word "comparable" only count lines that have a
 * market price, so the delta is never skewed by lines the market could not
 * price.
 */
export interface MarketComparison {
  /** Sold value across every line, or the order's product value when lines are unavailable. */
  soldTotal: number;
  /** Sold value across the lines that have a market price. */
  comparableSoldTotal: number;
  /** Market price × quantity across those same lines. */
  comparableMarketTotal: number;
  /** Number of order lines considered. */
  lineCount: number;
  /** Number of order lines that have a market price. */
  comparableLineCount: number;
}

export interface LineMarketComparison {
  soldAmount: number;
  marketAmount: number | null;
  deltaAmount: number | null;
  deltaPercent: number | null;
}

const EMPTY_MARKET_COMPARISON: MarketComparison = {
  soldTotal: 0,
  comparableSoldTotal: 0,
  comparableMarketTotal: 0,
  lineCount: 0,
  comparableLineCount: 0,
};

/** Sold minus market across comparable lines, or null when nothing is comparable. */
export function getMarketDeltaAmount(comparison: MarketComparison): number | null {
  if (comparison.comparableLineCount === 0 || comparison.comparableMarketTotal <= 0) {
    return null;
  }

  return comparison.comparableSoldTotal - comparison.comparableMarketTotal;
}

/** Sold relative to market across comparable lines, as a percentage. Positive means above market. */
export function getMarketDeltaPercent(comparison: MarketComparison): number | null {
  return getMarketDeltaAmount(comparison) === null
    ? null
    : percentAboveMarket(comparison.comparableSoldTotal, comparison.comparableMarketTotal);
}

export function compareLineToMarket(line: OrderLineItem): LineMarketComparison {
  const soldAmount = line.unitPrice * line.quantity;

  if (line.marketPrice === undefined || line.marketPrice <= 0) {
    return { soldAmount, marketAmount: null, deltaAmount: null, deltaPercent: null };
  }

  const marketAmount = line.marketPrice * line.quantity;

  return {
    soldAmount,
    marketAmount,
    deltaAmount: soldAmount - marketAmount,
    deltaPercent: percentAboveMarket(soldAmount, marketAmount),
  };
}

export function compareLinesToMarket(lines: OrderLineItem[]): MarketComparison {
  return lines.reduce<MarketComparison>((comparison, line) => {
    const lineComparison = compareLineToMarket(line);
    const isComparable = lineComparison.marketAmount !== null;

    return {
      soldTotal: comparison.soldTotal + lineComparison.soldAmount,
      comparableSoldTotal:
        comparison.comparableSoldTotal + (isComparable ? lineComparison.soldAmount : 0),
      comparableMarketTotal:
        comparison.comparableMarketTotal + (lineComparison.marketAmount ?? 0),
      lineCount: comparison.lineCount + 1,
      comparableLineCount: comparison.comparableLineCount + (isComparable ? 1 : 0),
    };
  }, EMPTY_MARKET_COMPARISON);
}

export function compareOrderToMarket(order: TcgPlayerShippingOrder): MarketComparison {
  if (!order.products || order.products.length === 0) {
    return {
      ...EMPTY_MARKET_COMPARISON,
      soldTotal: order["Value Of Products"],
    };
  }

  return compareLinesToMarket(order.products);
}

export function sumMarketComparisons(comparisons: MarketComparison[]): MarketComparison {
  return comparisons.reduce<MarketComparison>(
    (total, comparison) => ({
      soldTotal: total.soldTotal + comparison.soldTotal,
      comparableSoldTotal: total.comparableSoldTotal + comparison.comparableSoldTotal,
      comparableMarketTotal:
        total.comparableMarketTotal + comparison.comparableMarketTotal,
      lineCount: total.lineCount + comparison.lineCount,
      comparableLineCount: total.comparableLineCount + comparison.comparableLineCount,
    }),
    EMPTY_MARKET_COMPARISON,
  );
}

export function compareOrdersToMarket(orders: TcgPlayerShippingOrder[]): MarketComparison {
  return sumMarketComparisons(orders.map(compareOrderToMarket));
}

/** Compares every order in a shipment, so combined shipments are summed from their orders. */
export function compareShipmentToMarket(
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
  shipmentReference: string,
): MarketComparison {
  const orderNumbers = new Set(
    getOrderNumbersForShipmentReference(shipmentToOrderMap, shipmentReference),
  );

  return compareOrdersToMarket(
    sourceOrders.filter((order) => orderNumbers.has(order["Order #"])),
  );
}

/** "8.4% above market", "3.1% below market", "At market", or "No market price". */
export function describeMarketDelta(comparison: MarketComparison): string {
  const percent = getMarketDeltaPercent(comparison);

  switch (getMarketDeltaTone(percent)) {
    case "unavailable":
      return "No market price";
    case "at":
      return "At market";
    case "above":
      return `${Math.abs(percent ?? 0).toFixed(1)}% above market`;
    case "below":
      return `${Math.abs(percent ?? 0).toFixed(1)}% below market`;
  }
}

/** "41 of 43 lines priced" style coverage note, or null when every line is priced. */
export function describeMarketCoverage(comparison: MarketComparison): string | null {
  if (comparison.lineCount === 0) {
    return "No line items";
  }

  if (comparison.comparableLineCount === comparison.lineCount) {
    return null;
  }

  const noun = comparison.lineCount === 1 ? "line" : "lines";
  return `${comparison.comparableLineCount} of ${comparison.lineCount} ${noun} priced`;
}
