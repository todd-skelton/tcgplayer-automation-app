import { useState, useRef } from "react";
import type { ProcessingProgress, ProcessingSummary } from "../types/pricing";
import { SellerInventoryService } from "../services/sellerInventoryService";
import {
  convertSellerInventoryToListings,
  type SellerInventoryItem,
} from "../services/inventoryConverter";
import { ListingProcessor } from "../services/listingProcessor";
import { processWithConcurrency } from "../processWithConcurrency";
import type { TcgPlayerListing } from "../types/pricing";

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

      // Step 2.5: Validate and update missing SKUs
      setProgress({
        current: 0,
        total: listings.length,
        status: "Validating SKUs in database...",
        processed: 0,
        skipped: 0,
        errors: 0,
      });

      await validateAndUpdateSkus(
        listings,
        inventory,
        (current: number, total: number) => {
          setProgress({
            current,
            total,
            status: `Validating SKUs... (${current}/${total})`,
            processed: 0,
            skipped: 0,
            errors: 0,
          });
        }
      );

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

  /**
   * Validates that all SKUs exist in the database and updates missing products.
   *
   * This function ensures that all SKUs referenced in the seller inventory listings
   * are available in the local database before processing. It calls a server-side
   * API to handle all database operations and will:
   * 1. Extract unique SKU IDs from listings
   * 2. Extract unique product IDs from inventory items
   * 3. Call the validate-skus API to handle database operations server-side
   * 4. Track progress and handle cancellation
   *
   * @param listings - Array of TcgPlayerListing objects containing SKU references
   * @param inventory - Array of SellerInventoryItem objects with product details
   * @param onProgress - Optional callback to track validation progress
   */
  const validateAndUpdateSkus = async (
    listings: TcgPlayerListing[],
    inventory: SellerInventoryItem[],
    onProgress?: (current: number, total: number) => void
  ) => {
    // Extract unique SKU IDs from listings
    const skuIds = Array.from(
      new Set(
        listings
          .map((listing) => Number(listing["TCGplayer Id"]))
          .filter((skuId) => !isNaN(skuId) && skuId > 0)
      )
    );

    if (skuIds.length === 0) {
      return;
    }

    onProgress?.(0, skuIds.length);

    // Extract product IDs from inventory items
    const productIds = Array.from(
      new Set(inventory.map((item) => item.productId))
    );

    try {
      // Call the server-side API to validate and update SKUs
      const response = await fetch("/api/validate-skus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          skuIds,
          productIds,
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(result.error);
      }

      // Update progress to complete
      onProgress?.(skuIds.length, skuIds.length);

      console.log(`SKU validation complete: ${result.message}`);
    } catch (error) {
      console.error("Error validating SKUs:", error);
      throw error;
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
