import React from "react";
import { Box, Typography, Paper, Alert } from "@mui/material";
import { useSellerInventoryPipelineProcessor } from "../hooks/useSellerInventoryPipelineProcessor";
import {
  SellerForm,
  ProgressIndicator,
  ProcessingSummaryComponent,
} from "../components";

export default function SellerInventoryPricerRoute() {
  const {
    isProcessing,
    progress,
    error,
    warning,
    summary,
    processSellerInventory,
    handleCancel,
    setError,
  } = useSellerInventoryPipelineProcessor();

  const handleSubmit = async (sellerKey: string, percentile: number) => {
    if (!sellerKey.trim()) {
      setError("Please enter a seller key");
      return;
    }

    await processSellerInventory(sellerKey, percentile);
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Seller Inventory Pricer
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Process Seller Inventory
        </Typography>
        <SellerForm
          onSubmit={handleSubmit}
          isProcessing={isProcessing}
          onCancel={handleCancel}
        />
      </Paper>

      {/* Progress indicator */}
      {progress && <ProgressIndicator progress={progress} />}

      {/* Warning display */}
      {warning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography>{warning}</Typography>
        </Alert>
      )}

      {/* Error display */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography>{error}</Typography>
        </Alert>
      )}

      {/* Processing Summary */}
      {summary && <ProcessingSummaryComponent summary={summary} />}
    </Box>
  );
}
