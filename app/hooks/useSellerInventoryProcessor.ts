import { useState, useRef } from "react";
import type { ProcessingProgress, ProcessingSummary } from "../types/pricing";
import { SellerInventoryService } from "../services/sellerInventoryService";
import { convertSellerInventoryToListings } from "../services/inventoryConverter";
import { ListingProcessor } from "../services/listingProcessor";

export const useSellerInventoryProcessor = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const isCancelledRef = useRef(false);

  const inventoryService = new SellerInventoryService();
  const listingProcessor = new ListingProcessor();

  const processSellerInventory = async (
    sellerKey: string,
    percentile: number
  ) => {
    setIsProcessing(true);
    isCancelledRef.current = false;
    setError(null);
    setSummary(null);

    try {
      // Step 1: Fetch seller inventory
      setProgress({
        current: 0,
        total: 0,
        status: "Fetching seller inventory...",
        processed: 0,
        skipped: 0,
        errors: 0,
      });

      const inventory = await inventoryService.fetchSellerInventory({
        sellerKey,
        onProgress: (current, total, status) => {
          // During fetching, we don't know the final count yet
          setProgress({
            current: 0,
            total: 0,
            status,
            processed: 0,
            skipped: 0,
            errors: 0,
          });
        },
        isCancelled: () => isCancelledRef.current,
      });

      if (isCancelledRef.current) {
        return;
      }

      // Step 2: Convert to TcgPlayerListing format
      setProgress({
        current: 0,
        total: inventory.length,
        status: "Converting inventory to listing format...",
        processed: 0,
        skipped: 0,
        errors: 0,
      });

      const listings = convertSellerInventoryToListings(inventory);

      if (isCancelledRef.current) {
        return;
      }

      // Step 3: Process listings with pricing algorithm
      setProgress({
        current: 0,
        total: listings.length,
        status: "Starting price processing...",
        processed: 0,
        skipped: 0,
        errors: 0,
      });

      const { processedListings, summary } =
        await listingProcessor.processListings(
          listings,
          {
            percentile,
            onProgress: (progressData) => {
              setProgress({
                current: progressData.current,
                total: progressData.total,
                status: progressData.status,
                processed: progressData.processed,
                skipped: progressData.skipped,
                errors: progressData.errors,
              });
            },
            isCancelled: () => isCancelledRef.current,
          },
          `seller-${sellerKey}`
        );

      if (isCancelledRef.current) {
        return;
      }

      // Step 4: Complete processing
      setProgress({
        current: listings.length,
        total: listings.length,
        status: "Processing complete!",
        processed: summary.processedRows,
        skipped: summary.skippedRows,
        errors: summary.errorRows,
      });

      setSummary(summary);

      // Download the processed listings
      const filename = `priced-seller-${sellerKey}-${Date.now()}.csv`;
      listingProcessor.downloadProcessedListings(processedListings, filename);
    } catch (error: any) {
      if (error.message === "Processing cancelled by user") {
        console.log("Processing cancelled by user");
        return;
      }
      setError(error?.message || "Failed to process seller inventory");
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
    processSellerInventory,
    handleCancel,
    setError,
  };
};
