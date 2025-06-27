import { useState, useRef } from "react";
import Papa from "papaparse";
import type {
  TcgPlayerListing,
  ProcessingProgress,
  ProcessingSummary,
} from "../types/pricing";
import {
  PRICING_CONSTANTS,
  PERCENTILES,
  FILE_CONFIG,
} from "../constants/pricing";
import {
  calculateMedian,
  shouldSkipRow,
  initializeRowColumns,
  getRowQuantities,
  downloadCSV,
} from "../utils/csvProcessing";
import { getSuggestedPrice } from "../services/pricingService";

interface SummaryData {
  totalQuantity: number;
  totalAddQuantity: number;
  totals: {
    marketPrice: number;
    lowPrice: number;
    marketplacePrice: number;
    percentiles: { [key: string]: number };
  };
  totalsWithMarket: {
    marketPrice: number;
    percentiles: { [key: string]: number };
    quantityWithMarket: number;
  };
  daysToSellValues: number[];
  percentileDaysValues: { [key: string]: number[] };
}

export const useCSVProcessor = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const isCancelledRef = useRef(false);
  const processStartTime = useRef<number>(0);

  const initializeSummaryData = (): SummaryData => {
    const summaryData: SummaryData = {
      totalQuantity: 0,
      totalAddQuantity: 0,
      totals: {
        marketPrice: 0,
        lowPrice: 0,
        marketplacePrice: 0,
        percentiles: {},
      },
      totalsWithMarket: {
        marketPrice: 0,
        percentiles: {},
        quantityWithMarket: 0,
      },
      daysToSellValues: [],
      percentileDaysValues: {},
    };

    // Initialize percentile tracking
    PERCENTILES.forEach((p) => {
      summaryData.totals.percentiles[`${p}th`] = 0;
      summaryData.totalsWithMarket.percentiles[`${p}th`] = 0;
      summaryData.percentileDaysValues[`${p}th`] = [];
    });

    return summaryData;
  };
  const updateMarketplacePrice = (
    row: TcgPlayerListing,
    suggestedPrice: number
  ): void => {
    const currentTcgMarketPrice = Number(row["TCG Market Price"]) || 0;
    const currentMarketplacePrice = Number(row["TCG Marketplace Price"]) || 0;

    // If there's no current TCG Market Price, keep the current marketplace price
    if (currentTcgMarketPrice === 0) {
      // Keep existing marketplace price, add note if suggested price wasn't used
      if (suggestedPrice !== currentMarketplacePrice) {
        const existingError = row["Error"] || "";
        const errorMessage =
          "No TCG Market Price available - keeping current marketplace price";
        row["Error"] = existingError
          ? `${existingError}; ${errorMessage}`
          : errorMessage;
      }
      return;
    }

    // Calculate % of the current TCG Market Price
    const minimumPrice = currentTcgMarketPrice * (80 / 85);

    // If suggested price is less than (80/85)% of TCG Market Price, use TCG Market Price instead
    if (suggestedPrice < minimumPrice) {
      row["TCG Marketplace Price"] = currentTcgMarketPrice.toString();
      const existingError = row["Error"] || "";
      const errorMessage = `Suggested price below (80/85)% of TCG Market Price - using TCG Market Price`;
      row["Error"] = existingError
        ? `${existingError}; ${errorMessage}`
        : errorMessage;
    } else {
      // Use the suggested price as the new marketplace price
      row["TCG Marketplace Price"] = suggestedPrice.toString();
    }
  };

  const updateRowWithResults = (
    row: TcgPlayerListing,
    result: any,
    summaryData: SummaryData
  ): { success: boolean } => {
    if (result.error) {
      row["Error"] = result.error;
      return { success: false };
    }

    if (result.suggestedPrice === null) {
      row["Error"] = "No suggested price available";
      return { success: false };
    }
    row["Suggested Price"] = result.suggestedPrice.toString();
    row["Expected Days to Sell"] =
      result.expectedTimeToSellDays?.toString() || "";

    // Populate percentile data columns if available
    if (result.percentiles && result.percentiles.length > 0) {
      result.percentiles.forEach((percentileData: any) => {
        row[`Price ${percentileData.percentile}th Percentile`] =
          percentileData.price.toFixed(2);
        if (percentileData.expectedTimeToSellDays !== undefined) {
          row[`Days to Sell ${percentileData.percentile}th Percentile`] =
            percentileData.expectedTimeToSellDays.toFixed(2);
        }
      });
    }

    // Update TCG Marketplace Price based on pricing logic
    updateMarketplacePrice(row, result.suggestedPrice);

    // Update summary data
    updateSummaryData(row, summaryData);
    return { success: true };
  };
  const updateSummaryData = (
    row: TcgPlayerListing,
    summaryData: SummaryData
  ): void => {
    const { combinedQty } = getRowQuantities(row);

    const marketPrice = Number(row["TCG Market Price"]) || 0;
    const lowPrice = Number(row["TCG Low Price"]) || 0;
    const marketplacePrice = Number(row["TCG Marketplace Price"]) || 0;

    // Add to price totals
    summaryData.totals.marketPrice += marketPrice * combinedQty;
    summaryData.totals.lowPrice += lowPrice * combinedQty;
    summaryData.totals.marketplacePrice += marketplacePrice * combinedQty;

    // Track totals only for rows with market values
    const hasMarketValue = marketPrice > 0;
    if (hasMarketValue) {
      summaryData.totalsWithMarket.marketPrice += marketPrice * combinedQty;
      summaryData.totalsWithMarket.quantityWithMarket += combinedQty;

      // Add percentile totals only for rows with market values
      PERCENTILES.forEach((p) => {
        const percentilePrice = Number(row[`Price ${p}th Percentile`]) || 0;
        summaryData.totalsWithMarket.percentiles[`${p}th`] +=
          percentilePrice * combinedQty;
      });
    }

    // Collect days to sell for median calculation
    const expectedDays = Number(row["Expected Days to Sell"]) || 0;
    if (expectedDays > 0) {
      summaryData.daysToSellValues.push(expectedDays);
    }

    // Add percentile totals and collect days data
    PERCENTILES.forEach((p) => {
      const percentilePrice = Number(row[`Price ${p}th Percentile`]) || 0;
      const percentileDays = Number(row[`Days to Sell ${p}th Percentile`]) || 0;

      summaryData.totals.percentiles[`${p}th`] += percentilePrice * combinedQty;

      if (percentileDays > 0) {
        summaryData.percentileDaysValues[`${p}th`].push(percentileDays);
      }
    });
  };

  const createProcessingSummary = (
    file: File,
    percentile: number,
    totalRows: number,
    processed: number,
    skipped: number,
    errors: number,
    summaryData: SummaryData
  ): ProcessingSummary => {
    // Calculate medians for days to sell
    const medianDaysToSell = {
      expectedDaysToSell: calculateMedian(summaryData.daysToSellValues),
      percentiles: {} as { [key: string]: number },
    };

    PERCENTILES.forEach((p) => {
      medianDaysToSell.percentiles[`${p}th`] = calculateMedian(
        summaryData.percentileDaysValues[`${p}th`]
      );
    });

    const processingTime = Date.now() - processStartTime.current;
    const totalProcessed = processed + errors;
    const successRate =
      totalProcessed > 0 ? (processed / totalProcessed) * 100 : 0;

    return {
      totalRows,
      processedRows: processed,
      skippedRows: skipped,
      errorRows: errors,
      successRate,
      processingTime,
      fileName: file.name,
      percentileUsed: percentile,
      totalQuantity: summaryData.totalQuantity,
      totalAddQuantity: summaryData.totalAddQuantity,
      totals: summaryData.totals,
      totalsWithMarket: summaryData.totalsWithMarket,
      medianDaysToSell,
    };
  };

  const processCSV = async (file: File, percentile: number) => {
    setIsProcessing(true);
    isCancelledRef.current = false;
    setError(null);
    setSummary(null);
    processStartTime.current = Date.now();

    try {
      // Parse CSV
      const csvText = await file.text();
      const results = Papa.parse<TcgPlayerListing>(csvText, {
        header: true,
        skipEmptyLines: true,
      });
      const rows = results.data;
      let processed = 0;
      let skipped = 0;
      let errors = 0;

      const summaryData = initializeSummaryData();

      // Initialize new columns for all rows first
      rows.forEach((row) => {
        initializeRowColumns(row);
      });

      // Filter out rows that should be skipped before processing
      const filteredRows = rows.filter((row) => {
        if (shouldSkipRow(row)) {
          skipped++;
          return false;
        }

        // Track quantities for summary
        const { totalQty, addQty } = getRowQuantities(row);
        summaryData.totalQuantity += totalQty;
        summaryData.totalAddQuantity += addQty;

        return true;
      });

      // Initialize progress
      setProgress({
        current: 0,
        total: filteredRows.length,
        status: `Starting to process ${filteredRows.length} rows (${skipped} skipped)...`,
        processed: 0,
        skipped,
        errors: 0,
      });

      // Process filtered rows serially (one at a time)
      for (
        let rowIndex = 0;
        rowIndex < filteredRows.length && !isCancelledRef.current;
        rowIndex++
      ) {
        const row = filteredRows[rowIndex];

        // Update progress before processing
        setProgress({
          current: rowIndex + 1,
          total: filteredRows.length,
          status: `Processing row ${rowIndex + 1}/${filteredRows.length} (${
            row["Product Name"]
          })...`,
          processed,
          skipped,
          errors,
        });

        try {
          const result = await getSuggestedPrice(
            row["TCGplayer Id"],
            percentile
          );
          const { success } = updateRowWithResults(row, result, summaryData);

          if (success) {
            processed++;
          } else {
            errors++;
          }
        } catch (error: any) {
          row["Error"] = error?.message || "Processing error";
          errors++;
        }
      }

      // Check if cancelled before final steps
      if (isCancelledRef.current) {
        console.log("Processing cancelled by user");
        return;
      }

      // Final progress update
      setProgress({
        current: filteredRows.length,
        total: filteredRows.length,
        status: "Processing complete!",
        processed,
        skipped,
        errors,
      });

      // Create comprehensive summary
      const summary = createProcessingSummary(
        file,
        percentile,
        rows.length,
        processed,
        skipped,
        errors,
        summaryData
      );
      setSummary(summary);

      // Generate and download CSV with only the filtered (non-skipped) rows
      const filename = `${FILE_CONFIG.OUTPUT_PREFIX}${Date.now()}.csv`;
      downloadCSV(filteredRows, filename);
    } catch (error: any) {
      setError(error?.message || "Failed to process CSV");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    isCancelledRef.current = true;
    setIsProcessing(false);
    setProgress(null);
    setSummary(null);
  };

  return {
    isProcessing,
    progress,
    error,
    summary,
    processCSV,
    handleCancel,
    setError,
  };
};
