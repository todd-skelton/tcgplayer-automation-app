import { INVENTORY_CONDITION_ORDER } from "~/core/utils/conditionOrder";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";

/**
 * A condition ladder runs from the best graded condition down. A worse
 * condition never sells for more than a better one, so a price that breaks
 * that order is clamped to the better condition's price and the step is
 * flagged. Conditions outside the graded order, such as Unopened, keep their
 * own price and neither clamp nor get clamped.
 */
export interface LadderInput {
  condition: Condition;
  price: number | null;
}

export interface LadderStep {
  condition: Condition;
  /** The price after clamping to the better conditions above it. */
  price: number | null;
  /** True when the raw price sat above a better condition's price. */
  aboveBetterCondition: boolean;
}

const roundCurrency = (value: number): number => Math.round(value * 100) / 100;

const isPositive = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0;

function gradedRank(condition: Condition): number {
  return INVENTORY_CONDITION_ORDER.indexOf(
    condition as (typeof INVENTORY_CONDITION_ORDER)[number],
  );
}

export function buildConditionLadder(
  inputs: readonly LadderInput[],
): Map<Condition, LadderStep> {
  const ordered = [...inputs].sort(
    (left, right) => gradedRank(left.condition) - gradedRank(right.condition),
  );
  let ceiling: number | null = null;
  const step = ({ condition, price }: LadderInput): LadderStep => {
    if (!isPositive(price)) {
      return { condition, price: null, aboveBetterCondition: false };
    }
    const rounded = roundCurrency(price);
    if (gradedRank(condition) === -1) {
      return { condition, price: rounded, aboveBetterCondition: false };
    }
    const aboveBetterCondition = ceiling !== null && rounded > ceiling;
    const clamped = aboveBetterCondition ? ceiling! : rounded;
    ceiling = clamped;
    return { condition, price: clamped, aboveBetterCondition };
  };
  return new Map(ordered.map((input) => [input.condition, step(input)]));
}

export interface RefundInput {
  /** What the buyer paid for the condition they ordered. */
  pricePaid: number | null;
  /** Ladder price of the condition sold. */
  soldConditionPrice: number | null;
  /** Ladder price of the condition the buyer received. */
  receivedConditionPrice: number | null;
}

export interface RefundEstimate {
  /** Share of the sold condition's value the received condition keeps. */
  retainedShare: number;
  refund: number;
  /** What the buyer keeps paying after the refund. */
  netPrice: number;
}

/**
 * The partial refund that leaves the buyer paying the received condition's
 * share of what they paid for the sold condition. Never negative: a received
 * condition priced at or above the sold one earns no refund.
 */
export function estimateRefund(input: RefundInput): RefundEstimate | null {
  if (
    !isPositive(input.pricePaid) ||
    !isPositive(input.soldConditionPrice) ||
    !isPositive(input.receivedConditionPrice)
  ) {
    return null;
  }
  const retainedShare = Math.min(
    1,
    input.receivedConditionPrice / input.soldConditionPrice,
  );
  const refund = roundCurrency(input.pricePaid * (1 - retainedShare));
  return {
    retainedShare,
    refund,
    netPrice: roundCurrency(input.pricePaid - refund),
  };
}
