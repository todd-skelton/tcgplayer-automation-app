import { Alert, Chip, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { ValidatedNumberField } from "~/shared/components/ValidatedNumberField";
import type { TurnaroundMode, TurnaroundSelection } from "../types/turnaroundStrategy";
import { currencyFormatter } from "./format";

function date(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "unavailable";
}

function percent(value: number | null | undefined): string {
  return value == null ? "unavailable" : `${value.toFixed(0)}%`;
}

export function TurnaroundInputs({
  selection,
  productLine,
  busy,
  settingsError,
  scenarioComparison,
  onSave,
}: {
  selection: TurnaroundSelection;
  productLine: string;
  busy: boolean;
  settingsError?: string | null;
  scenarioComparison?: {
    horizonDays: number;
    effective: { cycleDays: number; profitPerDay: number };
    typical: { cycleDays: number; profitPerDay: number } | null;
    slower: { cycleDays: number; profitPerDay: number } | null;
  } | null;
  onSave: (mode: TurnaroundMode, manualTurnaroundDays: number) => void;
}) {
  const evidence = selection.evidence;
  const conditional = selection.setting.mode === "observed" && selection.fallbackReasons.length > 0;
  return (
    <Stack spacing={1.25} sx={{ mt: 2 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={selection.setting.mode}
          disabled={busy}
          onChange={(_, mode: TurnaroundMode | null) => {
            if (mode) onSave(mode, selection.setting.manualTurnaroundDays);
          }}
          aria-label={`${productLine} turnaround source`}
        >
          <ToggleButton value="manual">Manual</ToggleButton>
          <ToggleButton value="observed">Observed estimate</ToggleButton>
        </ToggleButtonGroup>
        <ValidatedNumberField
          size="small"
          label="Manual fallback days"
          value={selection.setting.manualTurnaroundDays}
          step={1}
          helperText="Saved for this seller and product-line scope"
          disabled={busy}
          isValid={(value) => value >= 0 && value <= 3650}
          onCommit={(value) => onSave(selection.setting.mode, value)}
        />
        <Chip
          color={selection.effectiveSource === "manual-fallback" ? "warning" : "success"}
          label={`Effective ${selection.effectiveDays.toFixed(1)} days · ${selection.effectiveSource.replaceAll("-", " ")}`}
        />
      </Stack>
      {scenarioComparison ? (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip variant="outlined" label={`${scenarioComparison.horizonDays}-day sell horizon + effective = ${scenarioComparison.effective.cycleDays.toFixed(1)}-day cycle · ${currencyFormatter.format(scenarioComparison.effective.profitPerDay)}/day modeled profit`} />
          {scenarioComparison.typical ? <Chip variant="outlined"
            label={`${conditional ? "Conditional typical" : "Typical"} = ${scenarioComparison.typical.cycleDays.toFixed(1)}-day cycle · ${currencyFormatter.format(scenarioComparison.typical.profitPerDay)}/day`} /> : null}
          {scenarioComparison.slower ? <Chip variant="outlined"
            label={`${conditional ? "Conditional slower" : "Slower"} = ${scenarioComparison.slower.cycleDays.toFixed(1)}-day cycle · ${currencyFormatter.format(scenarioComparison.slower.profitPerDay)}/day`} /> : null}
        </Stack>
      ) : null}
      {settingsError ? <Alert severity="error">{settingsError}</Alert> : null}
      {selection.setting.mode === "observed" && selection.fallbackReasons.length > 0 ? (
        <Alert severity="info">
          Manual fallback retained: {selection.fallbackReasons.join(" ")}
        </Alert>
      ) : null}
      {evidence ? (
        <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip variant="outlined" label={`Typical ${evidence.typicalDays?.toFixed(1) ?? "unavailable"} days`} />
            <Chip variant="outlined" label={`Slower p90 ${evidence.slowerDays?.toFixed(1) ?? "unavailable"} days`} />
            <Chip variant="outlined" label={`${evidence.completedPurchaseCount} completed purchases`} />
            <Chip variant="outlined" label={`${evidence.confidence} evidence confidence`} />
            <Chip variant="outlined" label={`Completed ${currencyFormatter.format(evidence.completedCents / 100)}`} />
            <Chip variant="outlined" color={evidence.waitingCents ? "warning" : "default"}
              label={`Waiting ${currencyFormatter.format(evidence.waitingCents / 100)}`} />
            {evidence.oldestWaitingDays !== null ? <Chip variant="outlined" color="warning"
              label={`Oldest waiting lower bound ${evidence.oldestWaitingDays.toFixed(1)} days`} /> : null}
            <Chip variant="outlined" label={`Reinvested ${percent(evidence.reinvestedPercent)} · completed ${percent(evidence.completionCoveragePercent)}`} />
            <Chip variant="outlined" color={evidence.unallocatedProceedsCents ? "warning" : "default"}
              label={`Unallocated ${currencyFormatter.format(evidence.unallocatedProceedsCents / 100)}`} />
            {evidence.oldestUnallocatedDays !== null ? <Chip variant="outlined" color="warning"
              label={`Oldest unallocated lower bound ${evidence.oldestUnallocatedDays.toFixed(1)} days`} /> : null}
            <Chip variant="outlined" color={evidence.unresolvedPurchaseCostCents ? "warning" : "default"}
              label={`Unresolved cost ${currencyFormatter.format(evidence.unresolvedPurchaseCostCents / 100)}`} />
            <Chip variant="outlined" color={evidence.unsupportedFundingAdjustmentCents ? "warning" : "default"}
              label={`Unsupported funding ${currencyFormatter.format(evidence.unsupportedFundingAdjustmentCents / 100)}`} />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {evidence.attribution === "seller-substituted-for-sparse-line"
              ? `Seller-wide pooled timing is attributed to ${productLine} because this line is sparse.`
              : evidence.scope === "product-line"
                ? `${productLine} means pooled proceeds attributed to replacement receipts in this product line.`
                : "Seller-wide pooled replacement timing."}
            {" "}Evidence as of {date(evidence.reportAsOf)}; 90-day sale cohort {date(evidence.observationFrom)}–{date(evidence.observationThrough)};
            order scan completed {date(evidence.orderCoverageFinishedAt)}. Observed order dates {date(evidence.orderObservedFrom)}–{date(evidence.orderObservedThrough)}
            are observations, not coverage boundaries. Provenance by dollars: actual proceeds {percent(evidence.actualProceedsPercent)},
            actual cost {percent(evidence.actualCostPercent)}, known funding {percent(evidence.knownFundingPercent)}. Source {evidence.sourceFingerprint.slice(0, 12)}.
            {" "}Excluded historical unknowns outside the cohort: {evidence.historicalUnknownProceedsCount} proceeds and {evidence.historicalUnknownCostCount} costs.
          </Typography>
          {evidence.limitations.map((limitation) => (
            <Typography key={limitation} variant="caption" color="text.secondary">• {limitation}</Typography>
          ))}
        </>
      ) : null}
    </Stack>
  );
}
