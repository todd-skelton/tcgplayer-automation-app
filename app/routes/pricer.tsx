import React from "react";
import { Box, Typography, Paper, Alert } from "@mui/material";
import { useCSVProcessor } from "../hooks/useCSVProcessor";
import {
  UploadForm,
  ProgressIndicator,
  ProcessingSummaryComponent,
} from "../components";

export default function PricerRoute() {
  const {
    isProcessing,
    progress,
    error,
    summary,
    processCSV,
    handleCancel,
    setError,
  } = useCSVProcessor();

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
        <Typography variant="h6" gutterBottom>
          Upload CSV File
        </Typography>
        <UploadForm
          onSubmit={handleSubmit}
          isProcessing={isProcessing}
          onCancel={handleCancel}
        />
      </Paper>

      {/* Progress indicator */}
      {progress && <ProgressIndicator progress={progress} />}

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
