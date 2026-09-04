import { Box, Chip, Paper, Stack, Typography } from "@mui/material";
import type { CapitalCycleEconomics } from "~/features/pricing/domain/capitalCycle";
import type {
  ForecastGradingReport,
  InventoryStrategyDashboard,
  InventoryStrategyProductLine,
} from "../types/inventoryStrategy";
import { cyclePortfolio } from "./capitalCycleInputs";
import {
  currencyFormatter,
  formatAge,
  formatCoverage,
  formatDays,
  formatDelta,
  formatHurdle,
} from "./format";
import { gradingStatus, hurdleReturns, type HurdleReturn } from "./verdict";

function formatReturn(dailyReturn: number): string {
  return `${(dailyReturn * 100).toFixed(2)}%/day`;
}

function formatDaysDelta(days: number): string {
  return `${days >= 0 ? "+" : "−"}${Math.abs(days).toFixed(1)} days`;
}

function policyLabel(dashboard: InventoryStrategyDashboard): string {
  const { policy, profitPerDay, productLines } = dashboard;
  if (policy.method === "percentile") {
    return "Configured percentile per product line";
  }
  if (policy.method === "target-horizon") {
    return `Target horizon of ${formatDays(policy.horizonDays)}`;
  }
  const ownHurdles = productLines.filter(
    (productLine) =>
      productLine.hurdleSweep.find((scenario) => scenario.configured)
        ?.dailyReturnHurdle !== profitPerDay.dailyReturnHurdle,
  ).length;
  const label = `Profit per day at a ${formatHurdle(profitPerDay.dailyReturnHurdle)} hurdle`;
  return ownHurdles === 0
    ? label
    : `${label}, ${ownHurdles} product ${ownHurdles === 1 ? "line" : "lines"} at their own`;
}

function gradingLabel(report: ForecastGradingReport | undefined): string {
  const status = gradingStatus(report);
  if (status.graded) {
    return `Forecasts graded: ${status.label} Brier ${status.grade.brier.toFixed(3)} against ${status.baseRate.toFixed(3)}`;
  }
  return status.gradableAt
    ? `Forecasts ungraded until ${new Date(status.gradableAt).toLocaleDateString()}`
    : "No forecasts recorded yet";
}

/** What the best hurdle offers over the configured one. */
function alternative(
  best: HurdleReturn | undefined,
  configured: HurdleReturn | undefined,
): { value: string; detail: string } {
  if (!best) {
    return {
      value: "None",
      detail: "No hurdle on the ladder grows the capital at these inputs",
    };
  }
  if (best.scenario.configured) {
    return {
      value: "Configured hurdle",
      detail: `Compounds fastest on the ladder at ${formatReturn(best.dailyReturn)}`,
    };
  }
  const change =
    configured &&
    configured.scenario.estimatedTime &&
    best.scenario.estimatedTime
      ? ` · ${formatDelta(best.scenario.physicalValue - configured.scenario.physicalValue)} listed · ${formatDaysDelta(best.scenario.estimatedTime.medianDays - configured.scenario.estimatedTime.medianDays)} median wait`
      : "";
  return {
    value: formatHurdle(best.scenario.dailyReturnHurdle),
    detail: `${formatReturn(best.dailyReturn)}${configured ? ` against ${formatReturn(configured.dailyReturn)} configured` : ""}${change}`,
  };
}

function curveAge(overall: InventoryStrategyProductLine): string {
  if (!overall.newestPricingAt || !overall.oldestPricingAt) {
    return "no saved curves";
  }
  const newest = formatAge(overall.newestPricingAt).toLowerCase();
  const oldest = formatAge(overall.oldestPricingAt).toLowerCase();
  return newest === oldest
    ? `curves ${newest} old`
    : `curves ${newest} to ${oldest} old`;
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" sx={{ my: 0.5 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {detail}
      </Typography>
    </Box>
  );
}

/**
 * The active policy, what it is expected to produce, the best hurdle the
 * sweep offers instead, and whether the forecasts behind it are graded.
 */
export function StrategyVerdict({
  dashboard,
  economics,
  grading,
}: {
  dashboard: InventoryStrategyDashboard;
  economics: CapitalCycleEconomics;
  grading: ForecastGradingReport | undefined;
}) {
  const { overall } = dashboard;
  const active = overall.policyComparisons.find(
    (comparison) => comparison.role === "active",
  );
  const modeledValue = active?.physicalValue ?? overall.currentPolicyValue;
  const returns = hurdleReturns(
    overall.hurdleSweep,
    cyclePortfolio(overall),
    economics,
  );
  const best = alternative(
    returns[0],
    returns.find(({ scenario }) => scenario.configured),
  );
  const status = gradingStatus(grading);

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
      >
        <Typography variant="h6">{policyLabel(dashboard)}</Typography>
        <Chip size="small" color="success" variant="outlined" label="Active" />
        <Chip
          size="small"
          variant="outlined"
          color={status.graded ? "success" : "default"}
          label={gradingLabel(grading)}
        />
      </Stack>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr",
            sm: "repeat(2, 1fr)",
            lg: "repeat(4, 1fr)",
          },
          gap: 2,
          mt: 2,
        }}
      >
        <Stat
          label="Modeled value"
          value={currencyFormatter.format(modeledValue)}
          detail={`${formatDelta(modeledValue - overall.currentListedValue)} against ${currencyFormatter.format(overall.currentListedValue)} listed now`}
        />
        <Stat
          label="Expected wait"
          value={
            active?.estimatedTime
              ? `${active.estimatedTime.medianDays.toFixed(1)} / ${active.estimatedTime.p90Days.toFixed(1)} days`
              : "Not modeled"
          }
          detail="Median / P90 for the next sale, weighted by units"
        />
        <Stat label="Best hurdle" value={best.value} detail={best.detail} />
        <Stat
          label="Modeled coverage"
          value={formatCoverage(overall.modeledUnitCount, overall.unitCount)}
          detail={`${overall.modeledSkuCount.toLocaleString()} of ${overall.skuCount.toLocaleString()} SKUs · ${curveAge(overall)}`}
        />
      </Box>
    </Paper>
  );
}
