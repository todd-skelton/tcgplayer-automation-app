import { useState, useRef } from "react";
import type { ProcessingProgress } from "../../../core/types/pricing";
import {
  useSupplyAnalysisConfig,
  useProductLinePricingConfig,
} from "../../pricing/hooks/useConfiguration";

export interface ProcessorBaseState {
  isProcessing: boolean;
  progress: ProcessingProgress | null;
  error: string | null;
  warning: string | null;
  success: string | null;
}

export const useProcessorBase = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const isCancelledRef = useRef(false);

  // Supply analysis configuration from localStorage
  const { config: supplyAnalysisConfig } = useSupplyAnalysisConfig();

  // Product line pricing configuration from localStorage
  const { config: productLinePricingConfig } = useProductLinePricingConfig();

  const handleCancel = () => {
    isCancelledRef.current = true;
    setIsProcessing(false);
    setProgress(null);
    setWarning(null);
  };

  const resetState = () => {
    setError(null);
    setWarning(null);
    setSuccess(null);
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
    isCancelledRef,

    // Configuration
    supplyAnalysisConfig,
    productLinePricingConfig,

    // State setters
    setIsProcessing,
    setProgress,
    setError,
    setWarning,
    setSuccess,

    // Actions
    handleCancel,
    resetState,
    startProcessing,
    finishProcessing,
  };
};
