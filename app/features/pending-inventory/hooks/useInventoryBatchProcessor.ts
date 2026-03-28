import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadCSV } from "~/core/utils/csvProcessing";
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

function createQueuedProgress(batchNumber: number) {
  return {
    current: 0,
    total: 1,
    status: `Batch ${batchNumber} is queued for pricing...`,
    processed: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
    phase: "Queued",
  };
}

export const useInventoryBatchProcessor = () => {
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<InventoryBatch | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingBatches, setIsLoadingBatches] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const latestSelectedBatchRef = useRef<InventoryBatch | null>(null);

  const updateBatchCollection = useCallback((nextBatch: InventoryBatch) => {
    setBatches((prev) => {
      const index = prev.findIndex(
        (candidate) => candidate.batchNumber === nextBatch.batchNumber,
      );

      if (index === -1) {
        return [nextBatch, ...prev].sort((a, b) => b.batchNumber - a.batchNumber);
      }

      const next = [...prev];
      next[index] = nextBatch;
      return next;
    });
    setSelectedBatch((prev) =>
      prev?.batchNumber === nextBatch.batchNumber ? nextBatch : prev,
    );
    latestSelectedBatchRef.current =
      latestSelectedBatchRef.current?.batchNumber === nextBatch.batchNumber
        ? nextBatch
        : latestSelectedBatchRef.current;
  }, []);

  const handleBatchTransition = useCallback((nextBatch: InventoryBatch) => {
    const previousBatch = latestSelectedBatchRef.current;
    const previousStatus = previousBatch?.latestJob?.status;
    const nextStatus = nextBatch.latestJob?.status;

    if (nextStatus === "completed" && previousStatus !== "completed") {
      setSuccess(
        nextBatch.latestJob?.mode === "errors"
          ? `Batch ${nextBatch.batchNumber} errors repriced successfully`
          : `Batch ${nextBatch.batchNumber} priced successfully`,
      );
      setError(null);
    }

    if (nextStatus === "failed" && previousStatus !== "failed") {
      setError(
        nextBatch.latestJob?.errorMessage ||
          `Batch ${nextBatch.batchNumber} pricing failed`,
      );
    }

    latestSelectedBatchRef.current = nextBatch;
  }, []);

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
    } catch (loadError) {
      setError(`Failed to load inventory batches: ${loadError}`);
      return [];
    } finally {
      setIsLoadingBatches(false);
    }
  }, []);

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
        handleBatchTransition(batch);
        updateBatchCollection(batch);
        setSelectedBatch(batch);
        return batch;
      } catch (loadError) {
        setError(`Failed to load batch: ${loadError}`);
        return null;
      }
    },
    [handleBatchTransition, updateBatchCollection],
  );

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    latestSelectedBatchRef.current = selectedBatch;
  }, [selectedBatch]);

  useEffect(() => {
    const batchNumber = selectedBatch?.batchNumber;
    if (!batchNumber) {
      streamRef.current?.close();
      streamRef.current = null;
      return;
    }

    const stream = new EventSource(
      `/api/inventory-batches/${batchNumber}/pricing-stream`,
    );
    streamRef.current = stream;

    const handleBatchEvent = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { batch: InventoryBatch };
      handleBatchTransition(payload.batch);
      updateBatchCollection(payload.batch);
      setSelectedBatch(payload.batch);
    };

    const handleStreamError = () => {
      if (stream.readyState === EventSource.CLOSED) {
        return;
      }
      setError("Lost live pricing updates for the selected batch");
    };

    stream.addEventListener("batch", handleBatchEvent as EventListener);
    stream.addEventListener("error", handleStreamError);

    return () => {
      stream.removeEventListener("batch", handleBatchEvent as EventListener);
      stream.removeEventListener("error", handleStreamError);
      stream.close();
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
    };
  }, [handleBatchTransition, selectedBatch?.batchNumber, updateBatchCollection]);

  const processBatch = useCallback(
    async (batchNumber: number, mode: InventoryBatchPricingMode) => {
      try {
        setError(null);
        const response = await fetch(
          `/api/inventory-batches/${batchNumber}/pricing-jobs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          },
        );
        const payload = (await response.json()) as {
          status?: string;
          mode?: InventoryBatchPricingMode;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Failed to queue batch pricing job",
          );
        }

        setSuccess(
          payload.status === "pricing"
            ? `Batch ${batchNumber} is already pricing`
            : payload.status === "queued"
            ? `Batch ${batchNumber} queued for pricing`
            : `Batch ${batchNumber} pricing requested`,
        );

        await loadBatch(batchNumber);
        await loadBatches();
      } catch (processError) {
        setError(String(processError));
        throw processError;
      }
    },
    [loadBatch, loadBatches],
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
        latestSelectedBatchRef.current = null;
      }

      const refreshedBatches = await loadBatches();
      setSuccess(`Batch ${batchNumber} deleted`);
      return refreshedBatches;
    },
    [loadBatches, selectedBatch?.batchNumber],
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
            ? "No manual review or error rows are available for this batch"
            : "No successful rows are available for this batch",
        );
      }

      downloadCSV(rows, getBatchResultFilename(batchNumber, scope));
    },
    [],
  );

  const progress = useMemo(() => {
    if (!selectedBatch?.latestJob) {
      return null;
    }

    if (selectedBatch.latestJob.status === "queued") {
      return createQueuedProgress(selectedBatch.batchNumber);
    }

    if (selectedBatch.latestJob.status === "pricing") {
      return (
        selectedBatch.latestJob.progress ||
        createQueuedProgress(selectedBatch.batchNumber)
      );
    }

    return null;
  }, [selectedBatch]);

  const isProcessing =
    selectedBatch?.latestJob?.status === "queued" ||
    selectedBatch?.latestJob?.status === "pricing";

  return {
    batches,
    selectedBatch,
    isLoadingBatches,
    isProcessing,
    progress,
    error,
    warning: null,
    success,
    summary: selectedBatch?.summary ?? null,
    handleCancel: undefined,
    setError,
    setSuccess,
    loadBatches,
    loadBatch,
    processBatch,
    deleteBatch,
    downloadBatchResults,
  };
};

