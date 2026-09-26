import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { Link } from "react-router";
import {
  intakeRunStatus,
  type InventoryIntakeRun,
  type IntakePublicationTarget,
} from "../types/inventoryIntakeRun";

export function InventoryIntakeProgress({
  refreshKey,
  onTarget,
}: {
  refreshKey: number;
  onTarget: (target: IntakePublicationTarget | null) => void;
}) {
  const [runs, setRuns] = useState<InventoryIntakeRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch("/api/inventory-intake-runs", {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            "Queue status could not be refreshed. Previously shown status may be out of date.",
          );
        const next = await response.json();
        if (!controller.signal.aborted) {
          setRuns(next.runs);
          onTarget(next.target);
          setPaused(next.target.publicationPaused);
          setError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : String(error));
          onTarget(null);
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refreshKey, onTarget]);

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="h6">Background inventory batches</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Keep adding inventory while queued batches run. Showing the latest 25
        handoffs; counts below are SKUs.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {paused && (
        <Alert severity="warning">
          Publication is paused or needs attention. Pricing can continue.{" "}
          <Link to="/publication-configuration">
            Review publication controls
          </Link>
          .
        </Alert>
      )}
      {!error && runs.length === 0 && (
        <Typography variant="body2">
          No background batches queued yet.
        </Typography>
      )}
      <Stack
        spacing={1}
        aria-live="polite"
        sx={{ maxHeight: 240, overflowY: "auto" }}
      >
        {runs.map((run) => (
          <Box key={run.batchNumber}>
            <Stack
              direction="row"
              spacing={2}
              alignItems="center"
              useFlexGap
              sx={{ flexWrap: "wrap" }}
            >
              <Button
                component={Link}
                to={`/pending-inventory-pricer?batch=${run.batchNumber}`}
              >
                Batch {run.batchNumber}
              </Button>
              <Chip size="small" label={intakeRunStatus(run)} />
              <Typography variant="body2">
                {run.quantity} units / {run.itemCount} SKUs;{" "}
                {run.publishedCount} published; {run.reviewCount} need review
              </Typography>
              <Typography variant="caption">
                {run.workflow === "publish"
                  ? "Publish when ready"
                  : "Pricing only"}
              </Typography>
            </Stack>
            {(run.planningError || run.pricingError) && (
              <Alert severity="warning">
                {run.planningError || run.pricingError}
              </Alert>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
