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
    exportInfo,
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

      {/* Export information */}
      {exportInfo && exportInfo.failedCount > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography variant="body2">
            <strong>Export Complete:</strong> {exportInfo.successfulCount} items
            exported to main file.
            {exportInfo.failedCount > 0 && (
              <>
                <br />
                <strong>{exportInfo.failedCount} items</strong> could not be
                priced (no sales data available) and have been exported to{" "}
                <strong>{exportInfo.manualReviewFile}</strong> for manual
                review.
              </>
            )}
          </Typography>
        </Alert>
      )}

      {/* Processing Summary */}
      {summary && <ProcessingSummaryComponent summary={summary} />}
    </Box>
  );
}
