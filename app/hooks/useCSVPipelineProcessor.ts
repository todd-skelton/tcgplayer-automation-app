import { useState, useRef } from "react";
import { useProcessorBase } from "./useProcessorBase";
import { PricingOrchestrator } from "../services/pricingOrchestrator";
import { CSVDataSource } from "../services/csvDataSource";
import type { PipelineResult } from "../services/pricingOrchestrator";

export const useCSVPipelineProcessor = () => {
  const [warning, setWarning] = useState<string | null>(null);
  const baseProcessor = useProcessorBase();
  const pricingOrchestrator = useRef(new PricingOrchestrator());
  const csvDataSource = useRef(new CSVDataSource());

  const processCSV = async (
    file: File,
    percentile: number
  ): Promise<PipelineResult | undefined> => {
    baseProcessor.startProcessing();
    setWarning(null);

    try {
      // Execute the standardized pricing pipeline
      const result = await pricingOrchestrator.current.executePipeline(
        csvDataSource.current,
        { file },
        {
          percentile,
          source: file.name,
          filename: `priced-${Date.now()}.csv`,
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
      baseProcessor.setExportInfo(result.exportInfo);
      return result;
    } catch (error: any) {
      if (error.message === "Processing cancelled by user") {
        console.log("Processing cancelled by user");
        return;
      }
      baseProcessor.setError(error?.message || "Failed to process CSV");
      throw error;
    } finally {
      baseProcessor.finishProcessing();
    }
  };

  const handleCancel = () => {
    baseProcessor.handleCancel();
    setWarning(null);
  };

  return {
    isProcessing: baseProcessor.isProcessing,
    progress: baseProcessor.progress,
    error: baseProcessor.error,
    warning,
    summary: baseProcessor.summary,
    exportInfo: baseProcessor.exportInfo,
    processCSV,
    handleCancel,
    setError: baseProcessor.setError,
  };
};
