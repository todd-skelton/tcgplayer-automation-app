import { useRef, useState } from "react";
import {
  Button,
  ButtonGroup,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Popover,
  Stack,
  Typography,
} from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { Link } from "react-router";
import { NextBatchCostFields } from "./NextBatchCostFields";
import {
  describeNextBatchCost,
  nextBatchCostProblem,
  type NextBatchCost,
} from "../services/nextBatchCost";
import type {
  IntakePublicationTarget,
  InventoryIntakeWorkflow,
} from "../types/inventoryIntakeRun";

const WORKFLOW_ACTIONS: Record<InventoryIntakeWorkflow, string> = {
  price_only: "Queue pricing only",
  publish: "Queue pricing & publishing",
};

/** Why the batch cannot be queued with this workflow and cost, or null when it can. */
function queueProblem(
  workflow: InventoryIntakeWorkflow,
  target: IntakePublicationTarget | null,
  cost: NextBatchCost,
): { message: string; publishing?: boolean } | null {
  if (!target) return { message: "Waiting for batch status before queuing." };
  if (workflow === "publish" && !target.canPublish)
    return { message: target.publishingUnavailableReason ?? "Publishing is not available.", publishing: true };
  const costProblem = nextBatchCostProblem(cost);
  return costProblem ? { message: costProblem } : null;
}

/** The unqueued quantities and the actions that hand them off as a batch. */
export function QueueBar({
  units,
  skuCount,
  cost,
  onCostChange,
  workflow,
  onWorkflowChange,
  target,
  queuing,
  onQueue,
  onClear,
}: {
  units: number;
  skuCount: number;
  cost: NextBatchCost;
  onCostChange: (cost: NextBatchCost) => void;
  workflow: InventoryIntakeWorkflow;
  onWorkflowChange: (workflow: InventoryIntakeWorkflow) => void;
  target: IntakePublicationTarget | null;
  queuing: boolean;
  onQueue: (workflow: InventoryIntakeWorkflow) => void;
  onClear: () => void;
}) {
  const costButton = useRef<HTMLButtonElement>(null);
  const workflowButton = useRef<HTMLButtonElement>(null);
  const [costOpen, setCostOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const problem = queueProblem(workflow, target, cost);

  return (
    <Paper
      elevation={6}
      component="section"
      aria-label="Unqueued inventory"
      sx={{ position: "sticky", bottom: 0, flexShrink: 0, zIndex: (theme) => theme.zIndex.appBar - 1, px: 2, py: 1.5 }}
    >
      <Stack direction="row" alignItems="center" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Typography variant="body2" color="primary" sx={{ fontWeight: 500 }}>
          {units} unqueued units across {skuCount} SKUs
        </Typography>
        <Button
          ref={costButton}
          size="small"
          aria-haspopup="dialog"
          color={nextBatchCostProblem(cost) ? "warning" : "primary"}
          onClick={() => setCostOpen(true)}
          sx={{ textTransform: "none" }}
        >
          Cost: {describeNextBatchCost(cost)}
        </Button>
        <Typography
          id="queue-problem"
          variant="caption"
          color="warning.main"
          role="status"
          sx={{ flex: 1, minWidth: 0, textAlign: "right" }}
        >
          {problem?.message}
          {problem?.publishing && (
            <>
              {" "}
              <Link to="/publication-configuration">Publication settings</Link>.
            </>
          )}
        </Typography>
        <ButtonGroup variant="contained" size="small" disabled={queuing}>
          <Button
            aria-describedby={problem ? "queue-problem" : undefined}
            disabled={queuing || Boolean(problem)}
            onClick={() => onQueue(workflow)}
          >
            {queuing ? "Saving & queuing..." : WORKFLOW_ACTIONS[workflow]}
          </Button>
          <Button
            ref={workflowButton}
            aria-label="Choose what queuing does"
            aria-haspopup="menu"
            aria-expanded={workflowOpen}
            onClick={() => setWorkflowOpen(true)}
          >
            <ArrowDropDownIcon />
          </Button>
        </ButtonGroup>
        <Button variant="outlined" color="secondary" size="small" disabled={queuing} onClick={onClear}>
          Clear unqueued
        </Button>
      </Stack>

      <Popover
        open={costOpen}
        anchorEl={costButton.current}
        onClose={() => setCostOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 2, maxWidth: 560 } } }}
      >
        <NextBatchCostFields value={cost} onChange={onCostChange} />
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
          <Button onClick={() => setCostOpen(false)}>Done</Button>
        </Stack>
      </Popover>

      <Menu
        open={workflowOpen}
        anchorEl={workflowButton.current}
        onClose={() => setWorkflowOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 420 } } }}
      >
        <MenuItem
          selected={workflow === "price_only"}
          onClick={() => {
            onWorkflowChange("price_only");
            setWorkflowOpen(false);
          }}
        >
          <ListItemText
            primary="Pricing only"
            secondary="Results wait for manual publication in the Batch Pricer."
            slotProps={{ secondary: { sx: { whiteSpace: "normal" } } }}
          />
        </MenuItem>
        <MenuItem
          selected={workflow === "publish"}
          onClick={() => {
            onWorkflowChange("publish");
            setWorkflowOpen(false);
          }}
        >
          <ListItemText
            primary="Pricing & publishing"
            secondary={
              !target?.canPublish
                ? target?.publishingUnavailableReason ?? "Publishing is not available right now."
                : target.publicationPaused
                  ? "Publication is paused or needs attention. Pricing continues; results wait until publication resumes."
                  : `Eligible results go live for seller ${target.sellerKey}, subject to publication safety controls.`
            }
            slotProps={{ secondary: { sx: { whiteSpace: "normal" } } }}
          />
        </MenuItem>
      </Menu>
    </Paper>
  );
}
