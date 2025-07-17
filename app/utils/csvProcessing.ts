import type { TcgPlayerListing } from "../types/pricing";
import { PRICING_CONSTANTS } from "../constants/pricing";
import Papa from "papaparse";

export const calculateMedian = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = values.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const shouldSkipRow = (row: TcgPlayerListing): boolean => {
  // Skip rows that start with "C-"
  if (row["TCGplayer Id"].startsWith(PRICING_CONSTANTS.SKIP_PREFIX)) {
    return true;
  }

  // Skip rows with no quantities
  const totalQty = Number(row["Total Quantity"]);
  const addQty = Number(row["Add to Quantity"]);
  return !totalQty && !addQty;
};

export const initializeRowColumns = (row: TcgPlayerListing): void => {
  row["Previous Price"] = row["TCG Marketplace Price"] || "";
  row["Suggested Price"] = "";
  row["Expected Days to Sell"] = "";
  row["Lowest Sale Price"] = "";
  row["Highest Sale Price"] = "";
  row["Sale Count"] = "";
  row["Error"] = "";
};

export const getRowQuantities = (row: TcgPlayerListing) => {
  const totalQty = Number(row["Total Quantity"]) || 0;
  const addQty = Number(row["Add to Quantity"]) || 0;
  const combinedQty = totalQty + addQty;
  return { totalQty, addQty, combinedQty };
};

export const downloadCSV = (
  data: TcgPlayerListing[],
  filename: string
): void => {
  const csvOutput = Papa.unparse(data);
  const blob = new Blob([csvOutput], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
