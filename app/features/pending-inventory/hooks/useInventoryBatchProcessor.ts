import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineResult } from "~/features/pricing/services/pricingOrchestrator";
import { PricingOrchestrator } from "~/features/pricing/services/pricingOrchestrator";
import { useProcessorBase } from "~/features/file-upload/hooks/useProcessorBase";
import { downloadCSV } from "~/core/utils/csvProcessing";
import { InventoryBatchDataSource } from "../services/inventoryBatchDataSource";
import type {
  InventoryBatch,
  InventoryBatchPricingMode,
  InventoryBatchResult,
  InventoryBatchResultsScope,
} from "../types/inventoryBatch";

function getBatchResultFilename(
  batchNumber: number,
  scope: InventoryBatchResultsScope,
): string {
  return scope === "manual-review"
    ? `inventory-batch-${batchNumber}-manual-review.csv`
    : `inventory-batch-${batchNumber}.csv`;
}

export const useInventoryBatchProcessor = () => {
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<InventoryBatch | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isLoadingBatches, setIsLoadingBatches] = useState(false);
  const baseProcessor = useProcessorBase();
  const pricingOrchestrator = useRef(new PricingOrchestrator());
  const batchDataSource = useRef(new InventoryBatchDataSource());

  const loadBatches = useCallback(async (): Promise<InventoryBatch[]> => {
    setIsLoadingBatches(true);

    try {
      const response = await fetch("/api/inventory-batches");
      if (!response.ok) {
        throw new Error("Failed to load inventory batches");
      }

      const data = (await response.json()) as InventoryBatch[];
      setBatches(data);
      return data;
    } catch (error) {
      baseProcessor.setError(`Failed to load inventory batches: ${error}`);
      return [];
    } finally {
      setIsLoadingBatches(false);
    }
  }, [baseProcessor.setError]);

  const loadBatch = useCallback(
    async (batchNumber: number): Promise<InventoryBatch | null> => {
      try {
        const response = await fetch(`/api/inventory-batches/${batchNumber}`);
        const payload = (await response.json()) as InventoryBatch | { error?: string };

        if (!response.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Failed to load batch",
          );
        }

        const batch = payload as InventoryBatch;
        setSelectedBatch(batch);
        baseProcessor.setSummary(batch.summary);
        return batch;
      } catch (error) {
        baseProcessor.setError(`Failed to load batch: ${error}`);
        return null;
      }
    },
    [baseProcessor],
  );

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const processBatch = useCallback(
    async (
      batchNumber: number,
      mode: InventoryBatchPricingMode = "full",
    ): Promise<PipelineResult | undefined> => {
      baseProcessor.startProcessing();
      setSuccess(null);
      batchDataSource.current.setContext(batchNumber, mode === "errors");

      try {
        const result = await pricingOrchestrator.current.executePipeline(
          batchDataSource.current,
          {},
          {
            percentile: baseProcessor.productLinePricingConfig.defaultPercentile,
            enableSupplyAnalysis:
              baseProcessor.supplyAnalysisConfig.enableSupplyAnalysis,
            supplyAnalysisConfig: {
              maxListingsPerSku:
                baseProcessor.supplyAnalysisConfig.maxListingsPerSku,
              includeUnverifiedSellers:
                baseProcessor.supplyAnalysisConfig.includeUnverifiedSellers,
            },
            productLinePricingConfig: baseProcessor.productLinePricingConfig,
            source: `inventory-batch-${batchNumber}`,
            enableEnrichment: true,
            enableExport: false,
            onProgress: (progress) => {
              baseProcessor.setProgress(progress);
            },
            onError: (error) => {
              baseProcessor.setError(error);
            },
            isCancelled: () => baseProcessor.isCancelledRef.current,
          },
        );

        const payload = {
          batchNumber,
          mode,
          summary: result.summary,
          pricedSkus: result.pricedSkus,
        };

        const saveResponse = await fetch(
          `/api/inventory-batches/${batchNumber}/results`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const savePayload = (await saveResponse.json()) as
          | InventoryBatch
          | { error?: string };

        if (!saveResponse.ok) {
          throw new Error(
            "error" in savePayload && savePayload.error
              ? savePayload.error
              : "Failed to save batch pricing results",
          );
        }

        const savedBatch = savePayload as InventoryBatch;
        setSelectedBatch(savedBatch);
        baseProcessor.setSummary(savedBatch.summary);
        await loadBatches();
        setSuccess(
          mode === "errors"
            ? `Batch ${batchNumber} errors repriced successfully`
            : `Batch ${batchNumber} priced successfully`,
        );

        return result;
      } catch (error: any) {
        if (error.message === "Processing cancelled by user") {
          return;
        }

        baseProcessor.setError(
          error?.message || "Failed to process inventory batch",
        );
        throw error;
      } finally {
        baseProcessor.finishProcessing();
      }
    },
    [baseProcessor, loadBatches],
  );

  const deleteBatch = useCallback(
    async (batchNumber: number): Promise<InventoryBatch[]> => {
      const response = await fetch(`/api/inventory-batches/${batchNumber}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to delete batch");
      }

      if (selectedBatch?.batchNumber === batchNumber) {
        setSelectedBatch(null);
        baseProcessor.setSummary(null);
      }

      const refreshedBatches = await loadBatches();
      setSuccess(`Batch ${batchNumber} deleted`);
      return refreshedBatches;
    },
    [baseProcessor, loadBatches, selectedBatch?.batchNumber],
  );

  const downloadBatchResults = useCallback(
    async (
      batchNumber: number,
      scope: InventoryBatchResultsScope,
    ): Promise<void> => {
      const response = await fetch(
        `/api/inventory-batches/${batchNumber}/results?scope=${scope}`,
      );
      const payload = (await response.json()) as
        | InventoryBatchResult[]
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Failed to load batch results",
        );
      }

      const results = payload as InventoryBatchResult[];
      const rows = results.map((result) => result.row);

      if (rows.length === 0) {
        throw new Error(
          scope === "manual-review"
            ? "No manual review rows are available for this batch"
            : "No successful rows are available for this batch",
        );
      }

      downloadCSV(rows, getBatchResultFilename(batchNumber, scope));
    },
    [],
  );

  return {
    batches,
    selectedBatch,
    isLoadingBatches,
    isProcessing: baseProcessor.isProcessing,
    progress: baseProcessor.progress,
    error: baseProcessor.error,
    warning: baseProcessor.warning,
    success,
    summary: selectedBatch ? selectedBatch.summary : baseProcessor.summary,
    handleCancel: baseProcessor.handleCancel,
    setError: baseProcessor.setError,
    setSuccess,
    loadBatches,
    loadBatch,
    processBatch,
    deleteBatch,
    downloadBatchResults,
  };
};
