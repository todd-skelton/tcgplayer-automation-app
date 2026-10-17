import { useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { Link } from "react-router";
import { ChangeCostRateDialog } from "./ChangeCostRateDialog";
import {
  describeIntakeRunSummary,
  intakeRunCost,
  intakeRunStatus,
  summarizeIntakeRuns,
  type InventoryIntakeRun,
} from "../types/inventoryIntakeRun";

/** A one-line status of queued batches that opens the full list on demand. */
export function BackgroundBatches({
  runs,
  error,
  publicationPaused,
  onRunChanged,
}: {
  runs: InventoryIntakeRun[];
  error: string | null;
  publicationPaused: boolean;
  onRunChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeIntakeRuns(runs);
  const needsAttention = summary.needsAttention > 0 || publicationPaused || Boolean(error);
  const status = error ? "status unavailable" : describeIntakeRunSummary(summary);

  return (
    <>
      <Badge badgeContent={summary.needsAttention} color="warning">
        <Button
          variant="outlined"
          color={needsAttention ? "warning" : "primary"}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Background batches:&nbsp;<span aria-live="polite">{status}</span>
        </Button>
      </Badge>
      <Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
        <BackgroundBatchList
          runs={runs}
          error={error}
          publicationPaused={publicationPaused}
          onClose={() => setOpen(false)}
          onRunChanged={onRunChanged}
        />
      </Drawer>
    </>
  );
}

function BackgroundBatchList({
  runs,
  error,
  publicationPaused,
  onClose,
  onRunChanged,
}: {
  runs: InventoryIntakeRun[];
  error: string | null;
  publicationPaused: boolean;
  onClose: () => void;
  onRunChanged: () => void;
}) {
  const [changingRate, setChangingRate] = useState<InventoryIntakeRun | null>(null);

  return (
    <Box role="region" aria-labelledby="background-batches-heading" sx={{ width: { xs: "100vw", sm: 520 }, p: 3 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography id="background-batches-heading" variant="h6">
          Background batches
        </Typography>
        <IconButton aria-label="Close background batches" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Keep adding inventory while queued batches run. Showing the latest 25
        handoffs; counts below are SKUs. <Link to="/pending-inventory-pricer">Open Batch Pricer</Link>.
      </Typography>
      <Stack spacing={1} sx={{ mb: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        {publicationPaused && (
          <Alert severity="warning">
            Publication is paused or needs attention. Pricing can continue.{" "}
            <Link to="/publication-configuration">Review publication controls</Link>.
          </Alert>
        )}
      </Stack>
      {!error && runs.length === 0 && (
        <Typography variant="body2">No background batches queued yet.</Typography>
      )}
      <Stack spacing={2}>
        {runs.map((run) => (
          <Box key={run.batchNumber}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
              <Button component={Link} to={`/pending-inventory-pricer?batch=${run.batchNumber}`}>
                Batch {run.batchNumber}
              </Button>
              <Chip size="small" label={intakeRunStatus(run)} />
              <Typography variant="caption">
                {run.workflow === "publish" ? "Publish when ready" : "Pricing only"}
              </Typography>
            </Stack>
            <Box sx={{ pl: 1 }}>
              <Typography variant="body2">
                {run.quantity} units / {run.itemCount} SKUs; {run.publishedCount} published;{" "}
                {run.reviewCount} need review
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="caption" color="text.secondary">
                  {intakeRunCost(run)}
                </Typography>
                {!run.hasEnteredCost && (
                  <Button size="small" onClick={() => setChangingRate(run)}>
                    Change rate
                  </Button>
                )}
              </Stack>
            </Box>
            {(run.planningError || run.pricingError) && (
              <Alert severity="warning">{run.planningError || run.pricingError}</Alert>
            )}
          </Box>
        ))}
      </Stack>
      {changingRate && (
        <ChangeCostRateDialog
          batchNumber={changingRate.batchNumber}
          currentRate={changingRate.costRate}
          onClose={() => setChangingRate(null)}
          onChanged={() => {
            setChangingRate(null);
            onRunChanged();
          }}
        />
      )}
    </Box>
  );
}
