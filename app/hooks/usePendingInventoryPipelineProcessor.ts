import { useState, useCallback, useEffect, useRef } from "react";
import { useProcessorBase } from "./useProcessorBase";
import { PricingOrchestrator } from "../services/pricingOrchestrator";
import { PendingInventoryDataSource } from "../services/pendingInventoryDataSource";
import type { PipelineResult } from "../services/pricingOrchestrator";

export const usePendingInventoryPipelineProcessor = () => {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [success, setSuccess] = useState<string | null>(null);
  const baseProcessor = useProcessorBase();
  const pricingOrchestrator = useRef(new PricingOrchestrator());
  const pendingDataSource = useRef(new PendingInventoryDataSource());

  // Load pending inventory count
  const loadPendingCount = useCallback(async () => {
    try {
      const count = await pendingDataSource.current.getPendingCount();
      setPendingCount(count);
    } catch (error) {
      baseProcessor.setError(
        `Failed to load pending inventory count: ${error}`
      );
    }
  }, [baseProcessor.setError]);

  // Load count on mount
  useEffect(() => {
    loadPendingCount();
  }, [loadPendingCount]);

  const clearPendingInventory = useCallback(async () => {
    try {
      await pendingDataSource.current.clearPendingInventory();
      setPendingCount(0);
      setSuccess("Pending inventory cleared successfully");
      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(null), 3000);
    } catch (error) {
      baseProcessor.setError(`Failed to clear pending inventory: ${error}`);
    }
  }, [baseProcessor.setError]);

  const processPendingInventory = useCallback(
    async (percentile: number = 50): Promise<PipelineResult | undefined> => {
      baseProcessor.startProcessing();
      setSuccess(null);

      try {
        // Execute the standardized pricing pipeline
        const result = await pricingOrchestrator.current.executePipeline(
          pendingDataSource.current,
          {},
          {
            percentile,
            source: "pending-inventory",
            filename: `priced-pending-inventory-${Date.now()}.csv`,
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

        // Clear pending inventory after successful processing
        await clearPendingInventory();
        await loadPendingCount(); // Reload count

        baseProcessor.setSummary(result.summary);
        baseProcessor.setExportInfo(result.exportInfo);
        setSuccess("Pending inventory processed and cleared successfully");

        // Clear success message after 5 seconds
        setTimeout(() => setSuccess(null), 5000);

        return result;
      } catch (error: any) {
        if (error.message === "Processing cancelled by user") {
          console.log("Processing cancelled by user");
          return;
        }
        baseProcessor.setError(
          error?.message || "Failed to process pending inventory"
        );
        throw error;
      } finally {
        baseProcessor.finishProcessing();
      }
    },
    [baseProcessor, clearPendingInventory, loadPendingCount]
  );

  return {
    isProcessing: baseProcessor.isProcessing,
    progress: baseProcessor.progress,
    error: baseProcessor.error,
    warning: baseProcessor.warning,
    success,
    summary: baseProcessor.summary,
    exportInfo: baseProcessor.exportInfo,
    handleCancel: baseProcessor.handleCancel,
    setError: baseProcessor.setError,
    pendingCount,
    loadPendingCount,
    processPendingInventory,
    clearPendingInventory,
  };
};
