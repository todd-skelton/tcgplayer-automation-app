import { useState, useRef } from "react";
import Papa from "papaparse";
import type {
  TcgPlayerListing,
  ProcessingProgress,
  ProcessingSummary,
} from "../types/pricing";
import { ListingProcessor } from "../services/listingProcessor";

export const useCSVProcessor = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const isCancelledRef = useRef(false);

  const listingProcessor = new ListingProcessor();

  const processCSV = async (file: File, percentile: number) => {
    setIsProcessing(true);
    isCancelledRef.current = false;
    setError(null);
    setWarning(null);
    setSummary(null);

    try {
      // Parse CSV
      const csvText = await file.text();
      const results = Papa.parse<TcgPlayerListing>(csvText, {
        header: true,
        skipEmptyLines: true,
      });
      const rows = results.data;

      if (isCancelledRef.current) {
        return;
      }

      // Process listings using the shared processor
      const { processedListings, summary } =
        await listingProcessor.processListings(
          rows,
          {
            percentile,
            onProgress: (progressData) => {
              // Check if this is a duplicate removal message
              if (progressData.status.includes("duplicate")) {
                const match = progressData.status.match(
                  /Removed (\d+) duplicate/
                );
                if (match) {
                  const duplicateCount = parseInt(match[1]);
                  const warningMessage = `Found and removed ${duplicateCount} duplicate SKU ID${
                    duplicateCount > 1 ? "s" : ""
                  } from CSV. Only the first occurrence of each SKU was processed.`;
                  setWarning(warningMessage);
                }
              }
              setProgress(progressData);
            },
            isCancelled: () => isCancelledRef.current,
          },
          file.name
        );

      if (isCancelledRef.current) {
        return;
      }

      setSummary(summary);

      // Download the processed listings
      listingProcessor.downloadProcessedListings(processedListings);
    } catch (error: any) {
      if (error.message === "Processing cancelled by user") {
        console.log("Processing cancelled by user");
        return;
      }
      setError(error?.message || "Failed to process CSV");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    isCancelledRef.current = true;
    setIsProcessing(false);
    setProgress(null);
    setWarning(null);
    setSummary(null);
  };

  return {
    isProcessing,
    progress,
    error,
    warning,
    summary,
    processCSV,
    handleCancel,
    setError,
  };
};
