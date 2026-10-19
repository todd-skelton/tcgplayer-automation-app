import { useRef, useState, type ReactNode } from "react";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import {
  Button,
  ButtonGroup,
  CircularProgress,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type { ShippingStepProgress } from "../services/shippingStepProgress";

/** The one thing the current step exists to do, such as buying postage. */
export interface ShippingStepAction {
  label: string;
  busy: boolean;
  disabled: boolean;
  /** Warning colors the action when it spends test-mode postage. */
  color?: "primary" | "warning";
  onClick: () => void;
}

/** Where the current step stands, its main action, and the way to the next step. */
export function ShippingStepBar({
  progress,
  action,
  nextStepLabel,
  onBack,
  onNext,
  onStartNewBatch,
  batchValue,
}: {
  progress: ShippingStepProgress;
  /** The whole batch's value, shown beside the step's progress. */
  batchValue?: ReactNode;
  action?: ShippingStepAction;
  /** The following step's name, or null on the last step. */
  nextStepLabel: string | null;
  /** Absent on the first step. */
  onBack?: () => void;
  onNext: () => void;
  onStartNewBatch: () => void;
}) {
  const skipButton = useRef<HTMLButtonElement>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const continueLabel = `Continue to ${nextStepLabel}`;
  const offersSkip = !progress.readyToContinue && progress.canSkip;

  return (
    <Paper
      elevation={6}
      component="section"
      aria-label="Current step"
      sx={{ position: "sticky", bottom: 0, flexShrink: 0, zIndex: (theme) => theme.zIndex.appBar - 1, px: 2, py: 1.5 }}
    >
      <Stack direction="row" alignItems="center" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Stack direction="row" alignItems="center" spacing={2} useFlexGap sx={{ flex: 1, minWidth: 0, flexWrap: "wrap" }}>
          <Typography variant="body2" color="primary" role="status" sx={{ fontWeight: 500 }}>
            {progress.summary}
          </Typography>
          {batchValue}
        </Stack>
        {action && (
          <Button
            variant="contained"
            size="small"
            color={action.color ?? "primary"}
            disabled={action.disabled}
            onClick={action.onClick}
            startIcon={action.busy ? <CircularProgress color="inherit" size={16} /> : undefined}
          >
            {action.label}
          </Button>
        )}
        {onBack && (
          <Button variant="outlined" size="small" onClick={onBack}>
            Back
          </Button>
        )}
        {nextStepLabel === null ? (
          <Button variant="contained" size="small" color="success" onClick={onStartNewBatch}>
            Start New Batch
          </Button>
        ) : offersSkip ? (
          <ButtonGroup variant="contained" size="small">
            <Button disabled>{continueLabel}</Button>
            <Button
              ref={skipButton}
              aria-label="More ways to continue"
              aria-haspopup="menu"
              aria-expanded={skipOpen}
              onClick={() => setSkipOpen(true)}
            >
              <ArrowDropDownIcon />
            </Button>
          </ButtonGroup>
        ) : (
          <Button variant="contained" size="small" disabled={!progress.readyToContinue} onClick={onNext}>
            {continueLabel}
          </Button>
        )}
      </Stack>

      <Menu
        open={skipOpen}
        anchorEl={skipButton.current}
        onClose={() => setSkipOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <MenuItem
          onClick={() => {
            setSkipOpen(false);
            onNext();
          }}
        >
          Skip to {nextStepLabel} before this step is done
        </MenuItem>
      </Menu>
    </Paper>
  );
}
