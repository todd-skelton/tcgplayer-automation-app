import type { ProductPriceMatrixCell } from "../types/productPriceMatrix";

type PercentileCell = Pick<
  ProductPriceMatrixCell,
  "percentileUsed" | "percentiles"
>;

export function getAvailablePercentiles(
  cells: readonly PercentileCell[],
): number[] {
  return [
    ...new Set(
      cells.flatMap((cell) => [
        ...(cell.percentiles ?? []).map((detail) => detail.percentile),
        ...(cell.percentileUsed === undefined ? [] : [cell.percentileUsed]),
      ]),
    ),
  ].sort((left, right) => left - right);
}

export function getConfiguredPercentiles(
  cells: readonly PercentileCell[],
): number[] {
  return [
    ...new Set(
      cells.flatMap((cell) =>
        cell.percentileUsed === undefined ? [] : [cell.percentileUsed],
      ),
    ),
  ].sort((left, right) => left - right);
}

export function formatPercentileLabel(percentile: number): string {
  const remainder = percentile % 100;

  if (remainder >= 11 && remainder <= 13) {
    return `${percentile}th`;
  }

  switch (percentile % 10) {
    case 1:
      return `${percentile}st`;
    case 2:
      return `${percentile}nd`;
    case 3:
      return `${percentile}rd`;
    default:
      return `${percentile}th`;
  }
}
