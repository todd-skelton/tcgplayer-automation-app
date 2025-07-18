import { useState, useRef } from "react";
import type { ProcessingProgress, ProcessingSummary } from "../types/pricing";
import type { PipelineResult } from "../services/pricingOrchestrator";

export interface ProcessorBaseState {
  isProcessing: boolean;
  progress: ProcessingProgress | null;
  error: string | null;
  warning: string | null;
  success: string | null;
  summary: ProcessingSummary | null;
  exportInfo: PipelineResult["exportInfo"] | null;
}

export const useProcessorBase = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [exportInfo, setExportInfo] = useState<
    PipelineResult["exportInfo"] | null
  >(null);
  const isCancelledRef = useRef(false);

  const handleCancel = () => {
    isCancelledRef.current = true;
    setIsProcessing(false);
    setProgress(null);
    setWarning(null);
    setSummary(null);
    setExportInfo(null);
  };

  const resetState = () => {
    setError(null);
    setWarning(null);
    setSuccess(null);
    setSummary(null);
    setExportInfo(null);
    isCancelledRef.current = false;
  };

  const startProcessing = () => {
    setIsProcessing(true);
    resetState();
  };

  const finishProcessing = () => {
    setIsProcessing(false);
  };

  return {
    // State
    isProcessing,
    progress,
    error,
    warning,
    success,
    summary,
    exportInfo,
    isCancelledRef,

    // State setters
    setIsProcessing,
    setProgress,
    setError,
    setWarning,
    setSuccess,
    setSummary,
    setExportInfo,

    // Actions
    handleCancel,
    resetState,
    startProcessing,
    finishProcessing,
  };
};
