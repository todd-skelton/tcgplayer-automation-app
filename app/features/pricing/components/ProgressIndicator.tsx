import React from "react";
import {
  Box,
  Typography,
  Paper,
  LinearProgress,
  Chip,
  Button,
} from "@mui/material";
import type { ProcessingProgress } from "../../../core/types/pricing";

interface ProgressIndicatorProps {
  progress: ProcessingProgress;
  onCancel?: () => void;
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progress,
  onCancel,
}) => {
  const progressPercentage =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  const subProgressPercentage =
    progress.subProgress && progress.subProgress.total > 0
      ? (progress.subProgress.current / progress.subProgress.total) * 100
      : 0;

  const getElapsedTime = () => {
    if (!progress.phaseStartTime) return null;
    const elapsedMs = Date.now() - progress.phaseStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  const getProgressLabel = () => {
    if (progress.total === 0) {
      return "Initializing...";
    }

    return `Step ${progress.current} of ${progress.total}`;
  };

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 2,
          gap: 2,
        }}
      >
        <Typography variant="h6">Processing Progress</Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {progress.phase && (
            <>
              <Chip
                label={progress.phase}
                color="primary"
                size="small"
                variant="outlined"
              />
              {getElapsedTime() && (
                <Typography variant="caption" color="text.secondary">
                  {getElapsedTime()}
                </Typography>
              )}
            </>
          )}
          {onCancel && (
            <Button variant="outlined" color="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Box>
      </Box>

      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {getProgressLabel()}
          </Typography>
          {progress.total > 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              fontWeight="medium"
            >
              {Math.round(progressPercentage)}%
            </Typography>
          )}
        </Box>
        <LinearProgress
          variant={progress.total === 0 ? "indeterminate" : "determinate"}
          value={progressPercentage}
          sx={{ height: 10, borderRadius: 5 }}
        />
        <Typography variant="body2" sx={{ mt: 1, color: "text.primary" }}>
          {progress.status}
        </Typography>
      </Box>

      {progress.subProgress && (
        <Box
          sx={{
            mb: 3,
            pl: 2,
            borderLeft: "3px solid",
            borderColor: "primary.main",
          }}
        >
          <Box sx={{ display: "flex", justifyContent: "space-between", mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {progress.subProgress.current} of {progress.subProgress.total} items
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              fontWeight="medium"
            >
              {Math.round(subProgressPercentage)}%
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={subProgressPercentage}
            sx={{ height: 6, borderRadius: 3 }}
            color="secondary"
          />
          <Typography
            variant="caption"
            sx={{ mt: 0.5, display: "block", color: "text.secondary" }}
          >
            {progress.subProgress.status}
          </Typography>
        </Box>
      )}

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Chip
          label={`Processed: ${progress.processed}`}
          color="success"
          size="small"
        />
        <Chip label={`Skipped: ${progress.skipped}`} color="info" size="small" />
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
