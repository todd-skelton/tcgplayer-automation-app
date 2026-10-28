import type { OrderLineItem, TcgPlayerShippingOrder } from "../types/shippingExport";
import { compareOrdersToIntake, intakeDeltaAmount, intakeDeltaPercent } from "./orderIntakeComparison";
import {
  compareOrdersToMarket,
  describeMarketCoverage,
  getMarketDeltaAmount,
  getMarketDeltaPercent,
} from "./orderMarketComparison";
import { shippingInventorySkuId } from "./shippingOrderIdentity";

/** A value the sale price is measured against. */
export interface SaleComparison {
  /** Sale price of the units this comparison covers. */
  price: number;
  /** The reference value, such as the current market total. */
  total: number;
  /** Sale price minus the reference value over the same units; positive means sold above it. */
  difference: number;
  percent: number | null;
  /** What part of the sale the comparison covers, or null when it covers all of it. */
  partial: string | null;
}

/**
 * What a card, order, or batch sold for, measured against the current market
 * and the market when it came into inventory, with how long it was held.
 */
export interface SaleValue {
  price: number;
  market: SaleComparison | null;
  intake: SaleComparison | null;
  ageDays: number | null;
  agePartial: string | null;
}

function uniqueOrders(orders: TcgPlayerShippingOrder[]): TcgPlayerShippingOrder[] {
  return [...new Map(orders.map((order) => [order["Order #"], order])).values()];
}

export function saleValueOfOrders(orders: TcgPlayerShippingOrder[]): SaleValue {
  const unique = uniqueOrders(orders);
  const market = compareOrdersToMarket(unique);
  const intake = compareOrdersToIntake(unique);
  const marketDifference = getMarketDeltaAmount(market);
  const intakeDifference = intakeDeltaAmount(intake);

  return {
    price: market.soldTotal,
    market:
      marketDifference === null
        ? null
        : {
            price: market.comparableSoldTotal,
            total: market.comparableMarketTotal,
            difference: marketDifference,
            percent: getMarketDeltaPercent(market),
            partial: describeMarketCoverage(market),
          },
    intake:
      intakeDifference === null
        ? null
        : {
            price: intake.comparableSoldTotal,
            total: intake.intakeMarketTotal,
            difference: intakeDifference,
            percent: intakeDeltaPercent(intake),
            partial:
              intake.priceKnownQuantity < intake.orderedQuantity
                ? `${intake.priceKnownQuantity} of ${intake.orderedQuantity} units have an intake price`
                : null,
          },
    ageDays: intake.weightedDaysHeld,
    agePartial:
      intake.weightedDaysHeld !== null && intake.dateKnownQuantity < intake.orderedQuantity
        ? `${intake.dateKnownQuantity} of ${intake.orderedQuantity} units have an intake date`
        : null,
  };
}

/** The order narrowed to the chosen lines and their intake history, or null when none match. */
function narrowOrder(
  order: TcgPlayerShippingOrder,
  includesLine: (line: OrderLineItem) => boolean,
): TcgPlayerShippingOrder | null {
  const products = (order.products ?? []).filter(includesLine);
  if (products.length === 0) return null;

  const skuIds = new Set(products.map(shippingInventorySkuId));
  return {
    ...order,
    products,
    "Item Count": products.reduce((sum, line) => sum + line.quantity, 0),
    "Value Of Products": products.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
    ...(order.intakeHistory
      ? {
          intakeHistory: {
            ...order.intakeHistory,
            lines: order.intakeHistory.lines.filter((line) => skuIds.has(line.skuId)),
          },
        }
      : {}),
  };
}

/** One card's sale across the given orders, measured exactly as orders are. */
export function saleValueOfLines(
  orders: TcgPlayerShippingOrder[],
  includesLine: (line: OrderLineItem) => boolean,
): SaleValue {
  return saleValueOfOrders(
    uniqueOrders(orders)
      .map((order) => narrowOrder(order, includesLine))
      .filter((order): order is TcgPlayerShippingOrder => order !== null),
  );
}

/** Card values keyed by the pull sheet's numeric SKU. */
export function saleValuesBySku(orders: TcgPlayerShippingOrder[]): Map<number, SaleValue> {
  const skuIds = new Set(
    orders.flatMap((order) => (order.products ?? []).map((line) => line.skuId)),
  );
  const values = new Map<number, SaleValue>();
  for (const skuId of skuIds) {
    if (skuId === undefined) continue;
    values.set(skuId, saleValueOfLines(orders, (line) => line.skuId === skuId));
  }
  return values;
}
