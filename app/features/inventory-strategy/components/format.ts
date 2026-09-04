export const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

export function formatPercentile(percentile: number): string {
  const remainder = percentile % 100;
  if (remainder >= 11 && remainder <= 13) return `${percentile}th`;
  if (percentile % 10 === 1) return `${percentile}st`;
  if (percentile % 10 === 2) return `${percentile}nd`;
  if (percentile % 10 === 3) return `${percentile}rd`;
  return `${percentile}th`;
}

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
  if (ageHours < 48) return `${Math.round(ageHours)} hours`;
  return `${Math.round(ageHours / 24)} days`;
}

export function formatHurdle(dailyReturnHurdle: number): string {
  return `${(dailyReturnHurdle * 100).toFixed(2)}%/day`;
}

export function formatDays(days: number): string {
  const rounded = days >= 100 ? Math.round(days) : Math.round(days * 10) / 10;
  return `${rounded.toLocaleString()} days`;
}
