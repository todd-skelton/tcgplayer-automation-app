import { useRef } from "react";
import { useProcessorBase } from "./useProcessorBase";
import { PricingPipelineService } from "../services/pricingPipelineService";
import { SellerInventoryDataSource } from "../services/sellerInventoryDataSource";
import type { PipelineResult } from "../services/pricingPipelineService";

export const useSellerInventoryPipelineProcessor = () => {
  const baseProcessor = useProcessorBase();
  const pipelineService = useRef(new PricingPipelineService());
  const sellerDataSource = useRef(new SellerInventoryDataSource());

  const processSellerInventory = async (
    sellerKey: string,
    percentile: number
  ): Promise<PipelineResult | undefined> => {
    baseProcessor.startProcessing();

    try {
      // Clear any cached data to ensure fresh fetch
      sellerDataSource.current.clearCache();

      // First, fetch and validate the SKUs (this is seller-specific logic)
      baseProcessor.setProgress({
        current: 0,
        total: 0,
        status: "Fetching seller inventory...",
        processed: 0,
        skipped: 0,
        errors: 0,
      });

      // First, fetch seller inventory with progress tracking
      const inventory =
        await sellerDataSource.current.inventoryService.fetchSellerInventory({
          sellerKey,
          onProgress: (current, total, status) => {
            baseProcessor.setProgress({
              current: 0,
              total: 0,
              status: status || "Fetching seller inventory...",
              processed: 0,
              skipped: 0,
              errors: 0,
            });
          },
          isCancelled: () => baseProcessor.isCancelledRef.current,
        });

      if (baseProcessor.isCancelledRef.current) {
        return;
      }

      // Cache the fetched inventory so the pipeline doesn't fetch it again
      sellerDataSource.current.setCachedInventory(inventory, sellerKey);

      // Convert to PricerSku format for validation
      const pricerSkus = await sellerDataSource.current.convertToPricerSku(
        inventory
      );

      if (baseProcessor.isCancelledRef.current) {
        return;
      }

      // Validate and update missing SKUs (seller-specific requirement)
      baseProcessor.setProgress({
        current: 0,
        total: pricerSkus.length,
        status: "Validating SKUs in database...",
        processed: 0,
        skipped: 0,
        errors: 0,
      });

      await sellerDataSource.current.validateAndUpdateSkus(
        pricerSkus,
        inventory,
        {
          onProgress: (current: number, total: number, status: string) => {
            baseProcessor.setProgress({
              current,
              total,
              status,
              processed: 0,
              skipped: 0,
              errors: 0,
            });
          },
          isCancelled: () => baseProcessor.isCancelledRef.current,
        }
      );

      if (baseProcessor.isCancelledRef.current) {
        return;
      }

      // Now execute the standardized pricing pipeline
      // The pipeline will use the cached inventory data instead of fetching again
      const result = await pipelineService.current.executePipeline(
        sellerDataSource.current,
        { sellerKey },
        {
          percentile,
          source: `seller-${sellerKey}`,
          filename: `priced-seller-${sellerKey}-${Date.now()}.csv`,
          enableEnrichment: true,
          enableExport: true,
          onProgress: (progress) => {
            baseProcessor.setProgress(progress);
          },
          onError: (error) => {
            baseProcessor.setError(error);
          },
          isCancelled: () => baseProcessor.isCancelledRef.current,
        }
      );

      baseProcessor.setSummary(result.summary);
      return result;
    } catch (error: any) {
      if (error.message === "Processing cancelled by user") {
        console.log("Processing cancelled by user");
        throw error;
      }
      baseProcessor.setError(
        error?.message || "Failed to process seller inventory"
      );
      throw error;
    } finally {
      baseProcessor.finishProcessing();
    }
  };

  return {
    isProcessing: baseProcessor.isProcessing,
    progress: baseProcessor.progress,
    error: baseProcessor.error,
    warning: baseProcessor.warning,
    summary: baseProcessor.summary,
    processSellerInventory,
    handleCancel: baseProcessor.handleCancel,
    setError: baseProcessor.setError,
  };
};
