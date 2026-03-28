import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ProgressIndicator } from "../../pricing/components";
import { InventoryBatchSummaryComponent } from "../components/InventoryBatchSummary";
import { useInventoryBatchProcessor } from "../hooks/useInventoryBatchProcessor";
import type {
  InventoryBatch,
  InventoryBatchPricingMode,
  InventoryBatchResultsScope,
} from "../types/inventoryBatch";

function getBatchStatusColor(status: InventoryBatch["status"]) {
  switch (status) {
    case "priced":
      return "success" as const;
    case "queued":
      return "info" as const;
    case "pricing":
      return "primary" as const;
    case "failed":
      return "error" as const;
    default:
      return "default" as const;
  }
}

function BatchSummaryCard({ batch }: { batch: InventoryBatch }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          alignItems={{ sm: "center" }}
          flexWrap="wrap"
        >
          <Typography variant="h6">Batch {batch.batchNumber}</Typography>
          <Chip
            label={`${batch.itemCount} SKUs`}
            color="info"
            variant="outlined"
            size="small"
          />
          <Chip
            label={batch.status}
            color={getBatchStatusColor(batch.status)}
            variant="filled"
            size="small"
          />
          {batch.latestJob && (
            <Chip
              label={`${batch.latestJob.mode} job: ${batch.latestJob.status}`}
              color={getBatchStatusColor(
                batch.latestJob.status === "completed"
                  ? "priced"
                  : batch.latestJob.status,
              )}
              variant="outlined"
              size="small"
            />
          )}
          <Chip
            label={`${batch.successfulCount} successful`}
            color="success"
            variant="outlined"
            size="small"
          />
          <Chip
            label={`${batch.manualReviewCount} manual review/errors`}
            color="warning"
            variant="outlined"
            size="small"
          />
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 0.5 }}>
          <Chip
            label={`Created ${new Date(batch.createdAt).toLocaleDateString()}`}
            color="success"
            size="small"
            variant="filled"
          />
          <Divider
            orientation="horizontal"
            sx={{
              width: 32,
              borderColor: batch.lastPricedAt ? "success.main" : "action.disabled",
              borderWidth: 1,
            }}
          />
          {batch.lastPricedAt ? (
            <Chip
              label={`Priced ${new Date(batch.lastPricedAt).toLocaleDateString()}`}
              color="success"
              size="small"
              variant="filled"
            />
          ) : (
            <Chip
              label="Not yet priced"
              size="small"
              variant="outlined"
              sx={{ borderStyle: "dashed" }}
            />
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

export default function PendingInventoryPricerRoute() {
  const {
    batches,
    selectedBatch,
    isLoadingBatches,
    isProcessing,
    progress,
    error,
    success,
    summary,
    processBatch,
    deleteBatch,
    downloadBatchResults,
    loadBatch,
    setError,
    setSuccess,
  } = useInventoryBatchProcessor();
  const [searchParams, setSearchParams] = useSearchParams();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  useEffect(() => {
    if (!success) {
      return;
    }

    const timeout = window.setTimeout(() => setSuccess(null), 10000);
    return () => window.clearTimeout(timeout);
  }, [success, setSuccess]);

  const requestedBatchNumber = useMemo(() => {
    const batchParam = searchParams.get("batch");
    if (!batchParam) {
      return null;
    }

    const batchNumber = Number(batchParam);
    return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
  }, [searchParams]);

  useEffect(() => {
    if (batches.length === 0) {
      return;
    }

    const nextBatchNumber =
      requestedBatchNumber &&
      batches.some((batch) => batch.batchNumber === requestedBatchNumber)
        ? requestedBatchNumber
        : batches[0].batchNumber;

    if (requestedBatchNumber !== nextBatchNumber) {
      setSearchParams({ batch: String(nextBatchNumber) }, { replace: true });
      return;
    }

    if (selectedBatch?.batchNumber !== nextBatchNumber) {
      void loadBatch(nextBatchNumber);
    }
  }, [
    batches,
    selectedBatch?.batchNumber,
    requestedBatchNumber,
    loadBatch,
    setSearchParams,
  ]);

  const handleSelectBatch = async (batchNumber: number) => {
    setSearchParams({ batch: String(batchNumber) });
    await loadBatch(batchNumber);
  };

  const handleProcessBatch = async (mode: InventoryBatchPricingMode) => {
    if (!selectedBatch) {
      setError("Select a batch first");
      return;
    }

    await processBatch(selectedBatch.batchNumber, mode);
  };

  const handleConfirmDelete = async () => {
    if (!selectedBatch) {
      return;
    }

    setDeleteDialogOpen(false);
    const refreshedBatches = await deleteBatch(selectedBatch.batchNumber);

    if (refreshedBatches.length > 0) {
      const nextBatchNumber = refreshedBatches[0].batchNumber;
      setSearchParams({ batch: String(nextBatchNumber) });
      await loadBatch(nextBatchNumber);
      return;
    }

    setSearchParams({});
  };

  const handleDownload = async (scope: InventoryBatchResultsScope) => {
    if (!selectedBatch) {
      return;
    }

    try {
      await downloadBatchResults(selectedBatch.batchNumber, scope);
    } catch (downloadError) {
      setError(String(downloadError));
    }
  };

  const hasPricingResults = Boolean(selectedBatch?.lastPricedAt);
  const isSelectedBatchActive =
    selectedBatch?.latestJob?.status === "queued" ||
    selectedBatch?.latestJob?.status === "pricing";

  return (
    <Box sx={{ maxWidth: 1100, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Inventory Batch Pricer
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" gutterBottom>
              Select Inventory Batch
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Each batch is a frozen snapshot from Inventory Manager. New live
              inventory can continue to be entered while you price a different
              batch here.
            </Typography>
          </Box>

          {batches.length > 0 ? (
            <FormControl sx={{ minWidth: 280, maxWidth: 480 }}>
              <InputLabel id="batch-select-label">Batch</InputLabel>
              <Select
                labelId="batch-select-label"
                label="Batch"
                value={selectedBatch?.batchNumber ?? ""}
                onChange={(event) => void handleSelectBatch(Number(event.target.value))}
                disabled={isLoadingBatches}
                renderValue={(value) => {
                  const batch = batches.find(
                    (candidate) => candidate.batchNumber === value,
                  );
                  return batch
                    ? `Batch ${batch.batchNumber} - ${batch.status}`
                    : "";
                }}
              >
                {batches.map((batch) => (
                  <MenuItem key={batch.batchNumber} value={batch.batchNumber}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: "100%" }}>
                      <Typography variant="body2" sx={{ mr: 1 }}>
                        Batch {batch.batchNumber}
                      </Typography>
                      <Chip label={`${batch.itemCount} SKUs`} size="small" variant="outlined" />
                      <Chip
                        label={batch.status}
                        size="small"
                        color={getBatchStatusColor(batch.status)}
                        variant="filled"
                      />
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : (
            <Alert severity="info">
              No inventory batches exist yet. Create one from the <Link to="/inventory-manager">Inventory Manager</Link> by clicking Process &amp; Price.
            </Alert>
          )}

          {selectedBatch && <BatchSummaryCard batch={selectedBatch} />}
        </Stack>
      </Paper>

      {selectedBatch && (
        <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
          <Stack spacing={3}>
            <Typography variant="h6">Actions</Typography>

            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              alignItems={{ md: "center" }}
            >
              <Stack direction="row" spacing={1}>
                <Tooltip
                  title={`Will queue pricing for ${selectedBatch.itemCount} SKUs using the server pricing configuration`}
                >
                  <span>
                    <Button
                      variant="contained"
                      onClick={() => void handleProcessBatch("full")}
                      disabled={isSelectedBatchActive}
                    >
                      {hasPricingResults ? "Reprice Batch" : "Price Batch"}
                    </Button>
                  </span>
                </Tooltip>
                <Button
                  variant="outlined"
                  color="warning"
                  onClick={() => void handleProcessBatch("errors")}
                  disabled={
                    isSelectedBatchActive ||
                    !hasPricingResults ||
                    selectedBatch.manualReviewCount === 0
                  }
                >
                  Reprice Errors ({selectedBatch.manualReviewCount})
                </Button>
              </Stack>

              <Divider
                orientation="vertical"
                flexItem
                sx={{ display: { xs: "none", md: "block" } }}
              />

              <Stack direction="row" spacing={1}>
                <Button
                  variant="outlined"
                  startIcon={<DownloadIcon />}
                  onClick={() => void handleDownload("successful")}
                  disabled={!hasPricingResults || selectedBatch.successfulCount === 0}
                >
                  Successful ({selectedBatch.successfulCount})
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  startIcon={<DownloadIcon />}
                  onClick={() => void handleDownload("manual-review")}
                  disabled={
                    !hasPricingResults || selectedBatch.manualReviewCount === 0
                  }
                >
                  Manual Review / Errors ({selectedBatch.manualReviewCount})
                </Button>
              </Stack>

              <Divider
                orientation="vertical"
                flexItem
                sx={{ display: { xs: "none", md: "block" } }}
              />

              <Button
                variant="outlined"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={() => setDeleteDialogOpen(true)}
                disabled={isSelectedBatchActive}
              >
                Delete Batch
              </Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      {progress && <ProgressIndicator progress={progress} />}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>
          <Typography>{success}</Typography>
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          <Typography>{error}</Typography>
        </Alert>
      )}

      {selectedBatch && summary && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Current batch summary for the saved pricing results.
          </Typography>
          <InventoryBatchSummaryComponent
            summary={summary}
            lastPricedAt={selectedBatch.lastPricedAt}
          />
        </Box>
      )}

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Batch {selectedBatch?.batchNumber}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes the batch, its {selectedBatch?.itemCount} frozen items,
            and all saved pricing results. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={() => void handleConfirmDelete()} color="error" variant="contained">
            Delete Batch
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

