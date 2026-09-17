import {
  Alert,
  Box,
  Chip,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ValidatedNumberField } from "~/shared/components/ValidatedNumberField";
import type { TurnaroundMode, TurnaroundSelection } from "../types/turnaroundStrategy";
import { currencyFormatter } from "./format";

function date(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "unavailable";
}

function days(value: number | null | undefined): string {
  return value == null ? "Unavailable" : `${value.toFixed(1)} days`;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="h5" sx={{ my: 0.5 }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">{detail}</Typography>
    </Box>
  );
}

/**
 * How long sale proceeds take to come back as newly published inventory,
 * and which turnaround the capital-cycle model uses for this seller.
 */
export function CapitalTurnaround({
  selection,
  busy,
  error,
  settingsError,
  onSave,
}: {
  selection: TurnaroundSelection;
  busy: boolean;
  error?: string | null;
  settingsError?: string | null;
  onSave: (mode: TurnaroundMode, manualTurnaroundDays: number) => void;
}) {
  const { evidence, setting } = selection;
  const fallback = setting.mode === "observed" && selection.fallbackReasons.length > 0;
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="h6">Capital turnaround</Typography>
        <Chip
          size="small"
          variant="outlined"
          color={selection.effectiveSource === "manual-fallback" ? "warning" : "success"}
          label={`Using ${selection.effectiveDays.toFixed(1)} days · ${selection.effectiveSource.replaceAll("-", " ")}`}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Days from a sale until its proceeds are back on sale as replacement
        inventory, estimated from the last 90 days of completed cycles.
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" },
          gap: 2,
          mt: 2,
        }}
      >
        <Stat label="Typical" value={days(evidence?.typicalDays)} detail="Dollar-weighted mean of completed cycles" />
        <Stat label="Slower" value={days(evidence?.slowerDays)} detail="Dollar-weighted p90 scenario, not a confidence bound" />
        <Stat
          label="Evidence"
          value={evidence ? `${evidence.completedPurchaseCount} purchases` : "None"}
          detail={evidence
            ? `${evidence.confidence} confidence · ${currencyFormatter.format(evidence.completedCents / 100)} completed`
            : "No completed sale-to-publication cycles yet"}
        />
        <Stat
          label="Waiting"
          value={evidence ? currencyFormatter.format(evidence.waitingCents / 100) : "Unavailable"}
          detail={evidence?.oldestWaitingDays != null
            ? `Proceeds not yet republished · oldest ${evidence.oldestWaitingDays.toFixed(1)} days`
            : "Proceeds not yet republished"}
        />
      </Box>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mt: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={setting.mode}
          disabled={busy}
          onChange={(_, mode: TurnaroundMode | null) => {
            if (mode) onSave(mode, setting.manualTurnaroundDays);
          }}
          aria-label="Turnaround source"
        >
          <ToggleButton value="observed">Observed</ToggleButton>
          <ToggleButton value="manual">Manual</ToggleButton>
        </ToggleButtonGroup>
        <ValidatedNumberField
          size="small"
          label="Manual days"
          value={setting.manualTurnaroundDays}
          step={1}
          helperText="Used when manual is selected or observed evidence is too thin"
          disabled={busy}
          isValid={(value) => value >= 0 && value <= 3650}
          onCommit={(value) => onSave(setting.mode, value)}
        />
      </Stack>
      {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      {settingsError ? <Alert severity="error" sx={{ mt: 2 }}>{settingsError}</Alert> : null}
      {fallback ? (
        <Alert severity="info" sx={{ mt: 2 }}>
          Manual days retained: {selection.fallbackReasons.join(" ")}
        </Alert>
      ) : null}
      {evidence ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
          Evidence as of {date(evidence.reportAsOf)} · sale cohort {date(evidence.observationFrom)} to {date(evidence.observationThrough)} · costs, proceeds, and timing are estimated where records are missing.
        </Typography>
      ) : null}
    </Paper>
  );
}
