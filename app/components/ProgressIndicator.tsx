import React from "react";
import { Box, Typography, Paper, LinearProgress, Chip } from "@mui/material";
import type { ProcessingProgress } from "../types/pricing";

interface ProgressIndicatorProps {
  progress: ProcessingProgress;
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progress,
}) => {
  const progressPercentage =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  // Determine appropriate label based on context
  const getProgressLabel = () => {
    if (progress.total === 0) {
      return "Initializing...";
    }

    return `${progress.current} of ${progress.total} items`;
  };

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Typography variant="h6" gutterBottom>
        Processing Progress
      </Typography>

      <Box sx={{ mb: 2 }}>
        <LinearProgress
          variant={progress.total === 0 ? "indeterminate" : "determinate"}
          value={progressPercentage}
          sx={{ height: 8, borderRadius: 4 }}
        />
      </Box>

      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {getProgressLabel()}
        </Typography>
        {progress.total > 0 && (
          <Typography variant="body2" color="text.secondary">
            {Math.round(progressPercentage)}%
          </Typography>
        )}
      </Box>

      <Typography variant="body2" sx={{ mb: 2 }}>
        {progress.status}
      </Typography>

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Chip
          label={`Processed: ${progress.processed}`}
          color="success"
          size="small"
        />
        <Chip
          label={`Skipped: ${progress.skipped}`}
          color="info"
          size="small"
        />
        <Chip
          label={`Warnings: ${progress.warnings}`}
          color="warning"
          size="small"
        />
        <Chip label={`Errors: ${progress.errors}`} color="error" size="small" />
      </Box>
    </Paper>
  );
};
