export const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

export {
  formatDays,
  formatHurdle,
  formatPercentile,
} from "~/features/pricing/components/policyLabel";

export function formatCoverage(modeled: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((modeled / total) * 100)}%`;
}

export function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : "−"}${currencyFormatter.format(Math.abs(value))}`;
}

export function formatAge(isoDate: string | null): string {
  if (!isoDate) return "No saved curve";
  const ageHours = Math.max(
    0,
    (Date.now() - new Date(isoDate).getTime()) / (60 * 60 * 1000),
  );
  if (ageHours < 1) return "Less than 1 hour";
  if (ageHours < 48) return plural(Math.round(ageHours), "hour");
  return plural(Math.round(ageHours / 24), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
