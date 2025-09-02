import React from "react";
import { Box, Typography, Paper, Alert } from "@mui/material";
import { useCSVPipelineProcessor } from "../hooks/useCSVPipelineProcessor";
import { UploadForm } from "../../file-upload/components";
import {
  ProgressIndicator,
  ProcessingSummaryComponent,
  QuickSettings,
} from "../components";

export default function PricerRoute() {
  const {
    isProcessing,
    progress,
    error,
    warning,
    summary,
    exportInfo,
    processCSV,
    handleCancel,
    setError,
  } = useCSVPipelineProcessor();

  const handleSubmit = async (file: File, percentile: number) => {
    if (!file) {
      setError("Please select a CSV file");
      return;
    }

    await processCSV(file, percentile);
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        TCGPlayer CSV Pricer
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            mb: 3,
          }}
        >
          <Typography variant="h6">Upload CSV File</Typography>
          <QuickSettings compact />
        </Box>
        <UploadForm
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
