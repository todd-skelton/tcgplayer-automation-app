import type {
  ShippedOrder,
  ShippingThresholdSnapOutcome,
  SnapPublication,
} from "~/core/types/shippingThresholds";

/** How units in one group sold and what the orders they sold in looked like. */
export interface SaleGroupSummary {
  units: number;
  orders: number;
  /** Mean units per order, counting every line in those orders. */
  unitsPerOrder?: number;
  /** Mean value of everything else bought alongside the group's units, per order. */
  otherItemsValuePerOrder?: number;
  /** Share of orders with anything besides the group's units. */
  ordersWithAddOns?: number;
  /**
   * For units priced under the threshold, the share of orders that other
   * items carried to the threshold anyway.
   */
  ordersReachingThreshold?: number;
  /** Most units of the group bought in one order. */
  largestOrderUnits: number;
  /** Share of units bought in orders holding three or more of the group's units. */
  bulkOrderUnitShare?: number;
  /** Mean postage less buyer shipping after fees, over orders with postage. */
  shippingCostPerOrder?: number;
  /** Median days from the first publication of the decision to the sale. */
  medianDaysToSell?: number;
}

export interface ThresholdOutcome {
  threshold: number;
  snapPrice: number;
  /** SKUs by the outcome of their latest considered decision in the window. */
  listings: Record<ShippingThresholdSnapOutcome, number>;
  /** Units sold at the snap price while snapped. */
  snapped: SaleGroupSummary;
  /** Units sold within the snap range after the snap was considered and kept. */
  kept: SaleGroupSummary;
  /** Every unit sold from the threshold to the top of the snap range, for comparison. */
  justAbove: SaleGroupSummary;
}

export interface SnapOutcomeInputs {
  thresholds: readonly number[];
  snapRange: number;
  overheadRate: number;
  orders: readonly ShippedOrder[];
  publications: readonly SnapPublication[];
}

/** Three or more of a group's units in one order counts as buying in bulk. */
export const BULK_ORDER_UNITS = 3;
const DAY_MS = 86_400_000;

interface SoldUnits {
  order: ShippedOrder;
  units: number;
  unitPrice: number;
  daysToSell?: number;
}

/** A run of consecutive considered publications of one SKU with the same outcome. */
interface DecisionRun {
  firstPublishedAt: Date;
  latest: SnapPublication;
}

const toCents = (value: number): number => Math.round(value * 100);

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const round = (value: number | undefined, places = 2): number | undefined =>
  value === undefined ? undefined : Number(value.toFixed(places));

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeSales(
  sold: readonly SoldUnits[],
  threshold: number,
  overheadRate: number,
): SaleGroupSummary {
  const underThreshold = sold.every(
    ({ unitPrice }) => toCents(unitPrice) < toCents(threshold),
  );
  const byOrder = new Map<string, { order: ShippedOrder; units: number; value: number }>();
  for (const { order, units, unitPrice } of sold) {
    const entry = byOrder.get(order.orderNumber) ?? { order, units: 0, value: 0 };
    entry.units += units;
    entry.value += units * unitPrice;
    byOrder.set(order.orderNumber, entry);
  }
  const groups = [...byOrder.values()];
  const units = groups.reduce((sum, group) => sum + group.units, 0);
  const bulkUnits = groups
    .filter((group) => group.units >= BULK_ORDER_UNITS)
    .reduce((sum, group) => sum + group.units, 0);
  const shipping = groups.flatMap(({ order }) =>
    order.postage === undefined
      ? []
      : [order.postage - (order.buyerShipping ?? 0) * (1 - overheadRate)],
  );
  return {
    units,
    orders: groups.length,
    unitsPerOrder: round(
      mean(groups.map(({ order }) =>
        order.lines.reduce((sum, line) => sum + line.quantity, 0),
      )),
    ),
    otherItemsValuePerOrder: round(
      mean(groups.map(({ order, value }) => Math.max(0, order.itemValue - value))),
    ),
    ordersWithAddOns: round(
      mean(groups.map(({ order, value }) =>
        toCents(order.itemValue) > toCents(value) ? 1 : 0,
      )),
      3,
    ),
    ordersReachingThreshold: underThreshold
      ? round(
          mean(groups.map(({ order }) =>
            toCents(order.itemValue) >= toCents(threshold) ? 1 : 0,
          )),
          3,
        )
      : undefined,
    largestOrderUnits: Math.max(0, ...groups.map((group) => group.units)),
    bulkOrderUnitShare: units === 0 ? undefined : round(bulkUnits / units, 3),
    shippingCostPerOrder: round(mean(shipping)),
    medianDaysToSell: round(
      median(sold.flatMap(({ daysToSell }) =>
        daysToSell === undefined ? [] : [daysToSell],
      )),
      1,
    ),
  };
}

/** Each SKU's considered publications for one threshold, grouped into runs of one outcome. */
function decisionRuns(
  publications: readonly SnapPublication[],
  threshold: number,
): Map<number, DecisionRun[]> {
  const runs = new Map<number, DecisionRun[]>();
  for (const publication of publications) {
    if (publication.snap.threshold !== threshold) continue;
    const skuRuns = runs.get(publication.sku) ?? [];
    const current = skuRuns.at(-1);
    if (current && current.latest.snap.outcome === publication.snap.outcome) {
      current.latest = publication;
    } else {
      skuRuns.push({ firstPublishedAt: publication.publishedAt, latest: publication });
    }
    runs.set(publication.sku, skuRuns);
  }
  return runs;
}

function runAt(runs: readonly DecisionRun[] | undefined, time: Date): DecisionRun | undefined {
  return runs?.filter((run) => run.firstPublishedAt <= time).at(-1);
}

function thresholdOutcome(inputs: SnapOutcomeInputs, threshold: number): ThresholdOutcome {
  const snapPrice = (toCents(threshold) - 1) / 100;
  const rangeTop = toCents(threshold * (1 + inputs.snapRange));
  const runs = decisionRuns(inputs.publications, threshold);
  const snapped: SoldUnits[] = [];
  const kept: SoldUnits[] = [];
  const justAbove: SoldUnits[] = [];
  for (const order of inputs.orders) {
    for (const line of order.lines) {
      const sold = { order, units: line.quantity, unitPrice: line.unitPrice };
      const cents = toCents(line.unitPrice);
      if (cents >= toCents(threshold) && cents <= rangeTop) justAbove.push(sold);
      const run = runAt(runs.get(line.sku), order.orderTime);
      if (!run) continue;
      const daysToSell = (order.orderTime.getTime() - run.firstPublishedAt.getTime()) / DAY_MS;
      if (run.latest.snap.outcome === "snapped" && cents === toCents(snapPrice)) {
        snapped.push({ ...sold, daysToSell });
      } else if (
        run.latest.snap.outcome === "kept" &&
        cents >= toCents(threshold) && cents <= rangeTop
      ) {
        kept.push({ ...sold, daysToSell });
      }
    }
  }
  const listings: Record<ShippingThresholdSnapOutcome, number> = { snapped: 0, kept: 0, floor: 0 };
  for (const skuRuns of runs.values()) {
    listings[skuRuns.at(-1)!.latest.snap.outcome] += 1;
  }
  return {
    threshold,
    snapPrice,
    listings,
    snapped: summarizeSales(snapped, threshold, inputs.overheadRate),
    kept: summarizeSales(kept, threshold, inputs.overheadRate),
    justAbove: summarizeSales(justAbove, threshold, inputs.overheadRate),
  };
}

/**
 * What happened after snapping, per threshold: whether snapped listings
 * sold faster, drew add-ons that carried orders over the threshold, or were
 * bought up in bulk, beside listings that kept their price just above it.
 */
export function shippingThresholdSnapOutcomes(inputs: SnapOutcomeInputs): ThresholdOutcome[] {
  return [...inputs.thresholds]
    .sort((left, right) => left - right)
    .map((threshold) => thresholdOutcome(inputs, threshold));
}
