import React from "react";
import {
  Box,
  Typography,
  Paper,
  Alert,
  Button,
  TextField,
} from "@mui/material";
import { ProgressIndicator, ProcessingSummaryComponent } from "../components";
import { PRICING_CONSTANTS } from "../constants/pricing";
import { usePendingInventoryPipelineProcessor } from "~/hooks/usePendingInventoryPipelineProcessor";

export default function PendingInventoryPricerRoute() {
  const {
    isProcessing,
    progress,
    error,
    warning,
    success,
    summary,
    pendingCount,
    processPendingInventory,
    clearPendingInventory,
    handleCancel,
    setError,
  } = usePendingInventoryPipelineProcessor();

  const [percentile, setPercentile] = React.useState<number>(
    PRICING_CONSTANTS.DEFAULT_PERCENTILE
  );

  const handleSubmit = async () => {
    if (pendingCount === 0) {
      setError("No pending inventory items to process");
      return;
    }

    // Validate percentile range
    if (
      percentile < PRICING_CONSTANTS.MIN_PERCENTILE ||
      percentile > PRICING_CONSTANTS.MAX_PERCENTILE
    ) {
      setError(
        `Percentile must be between ${PRICING_CONSTANTS.MIN_PERCENTILE} and ${PRICING_CONSTANTS.MAX_PERCENTILE}`
      );
      return;
    }

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
                  min: PRICING_CONSTANTS.MIN_PERCENTILE,
                  max: PRICING_CONSTANTS.MAX_PERCENTILE,
                }}
                helperText={`${PRICING_CONSTANTS.MIN_PERCENTILE}-${PRICING_CONSTANTS.MAX_PERCENTILE}`}
              />
              <Button
                variant="contained"
                color="primary"
                onClick={handleSubmit}
                disabled={
                  isProcessing ||
                  percentile < PRICING_CONSTANTS.MIN_PERCENTILE ||
                  percentile > PRICING_CONSTANTS.MAX_PERCENTILE ||
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

      {/* Processing Summary */}
      {summary && <ProcessingSummaryComponent summary={summary} />}
    </Box>
  );
}
