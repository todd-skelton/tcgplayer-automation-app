import React from "react";
import {
  Box,
  Typography,
  Paper,
  Alert,
  Button,
  TextField,
} from "@mui/material";
import {
  ProgressIndicator,
  ProcessingSummaryComponent,
} from "../../pricing/components";
import { useConfiguration } from "../../pricing/hooks/useConfiguration";
import { usePendingInventoryPipelineProcessor } from "../hooks/usePendingInventoryPipelineProcessor";

export default function PendingInventoryPricerRoute() {
  const { config, updateFormDefaults } = useConfiguration();
  const {
    isProcessing,
    progress,
    error,
    warning,
    success,
    summary,
    exportInfo,
    pendingCount,
    processPendingInventory,
    clearPendingInventory,
    handleCancel,
    setError,
  } = usePendingInventoryPipelineProcessor();

  const [percentile, setPercentile] = React.useState<number>(
    config.formDefaults.percentile
  );

  const handleSubmit = async () => {
    if (pendingCount === 0) {
      setError("No pending inventory items to process");
      return;
    }

    // Validate percentile range
    if (
      percentile < config.pricing.minPercentile ||
      percentile > config.pricing.maxPercentile
    ) {
      setError(
        `Percentile must be between ${config.pricing.minPercentile} and ${config.pricing.maxPercentile}`
      );
      return;
    }

    // Save percentile as form default for next time
    updateFormDefaults({ percentile });

    await processPendingInventory(percentile);
  };

  const handleClearPending = async () => {
    if (
      window.confirm(
        "Are you sure you want to clear all pending inventory? This action cannot be undone."
      )
    ) {
      await clearPendingInventory();
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Pending Inventory Pricer
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Process Pending Inventory
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Process all pending inventory items and generate pricing. This will
          fetch current market data and calculate suggested prices for each
          item.
        </Typography>

        {pendingCount > 0 ? (
          <>
            <Alert severity="info" sx={{ mb: 3 }}>
              You have {pendingCount} pending inventory items ready for
              processing.
            </Alert>

            <Box sx={{ display: "flex", gap: 2, alignItems: "center", mb: 3 }}>
              <TextField
                label="Percentile"
                type="number"
                value={percentile}
                onChange={(e) => setPercentile(Number(e.target.value))}
                placeholder="Enter percentile (0-100)"
                sx={{ minWidth: 150 }}
                disabled={isProcessing}
                inputProps={{
                  min: config.pricing.minPercentile,
                  max: config.pricing.maxPercentile,
                }}
                helperText={`${config.pricing.minPercentile}-${config.pricing.maxPercentile}`}
              />
              <Button
                variant="contained"
                color="primary"
                onClick={handleSubmit}
                disabled={
                  isProcessing ||
                  percentile < config.pricing.minPercentile ||
                  percentile > config.pricing.maxPercentile ||
                  pendingCount === 0
                }
              >
                Process & Download CSV
              </Button>
              {isProcessing && (
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={handleCancel}
                >
                  Cancel
                </Button>
              )}
            </Box>

            <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
              <Button
                variant="outlined"
                color="error"
                onClick={handleClearPending}
                disabled={isProcessing}
              >
                Clear All Pending
              </Button>
              <Typography variant="body2" color="text.secondary">
                Clear all pending inventory without processing
              </Typography>
            </Box>
          </>
        ) : (
          <Alert severity="info">
            No pending inventory items found. Add items through the Inventory
            Manager first.
          </Alert>
        )}
      </Paper>

      {/* Progress indicator */}
      {progress && <ProgressIndicator progress={progress} />}

      {/* Success display */}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }}>
          <Typography>{success}</Typography>
        </Alert>
      )}

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
