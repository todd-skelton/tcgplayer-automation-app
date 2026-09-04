import {
  Box,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import {
  bestCapitalCycle,
  capitalCycleAtHorizon,
  type CapitalCycle,
  type CapitalCycleEconomics,
} from "~/features/pricing/domain/capitalCycle";
import {
  horizonGainElasticity,
  horizonKneeDays,
  horizonMarginalValuePerDay,
  horizonValue,
} from "~/features/pricing/domain/horizonValueCurve";
import {
  ValidatedNumberField,
  type NumberFieldDescriptor,
} from "~/shared/components/ValidatedNumberField";
import {
  INVENTORY_STRATEGY_HORIZON_DAYS,
  type InventoryStrategyDashboard,
  type InventoryStrategyProductLine,
} from "../types/inventoryStrategy";
import { currencyFormatter, formatDays } from "./format";

const fitConfidenceColor = {
  high: "success",
  medium: "warning",
  low: "default",
  unavailable: "default",
} as const;

/** Cycle inputs the reader can vary; overhead comes from the profit-per-day settings. */
type CapitalCycleInputs = Pick<
  CapitalCycleEconomics,
  "costBasisShareOfMarket" | "costBasisDiscountPerUnit" | "turnaroundDays"
>;

const DEFAULT_CAPITAL_CYCLE_INPUTS: CapitalCycleInputs = {
  costBasisShareOfMarket: 0.72,
  costBasisDiscountPerUnit: 0.3,
  turnaroundDays: 28,
};

const CAPITAL_CYCLE_FIELDS: NumberFieldDescriptor<CapitalCycleInputs>[] = [
  {
    key: "costBasisShareOfMarket",
    label: "Cost basis share of market",
    step: 0.01,
    helperText: "Fraction of market value paid for inventory",
  },
  {
    key: "costBasisDiscountPerUnit",
    label: "Cost basis discount per unit",
    step: 0.01,
    helperText: "Dollars off the cost basis for every unit bought",
  },
  {
    key: "turnaroundDays",
    label: "Turnaround days",
    step: 1,
    helperText: "Days from a sale until the proceeds are relisted",
  },
];

const emphasisColor = {
  knee: "success.main",
  cycle: "info.main",
  active: "text.primary",
} as const;

function cyclePortfolio(productLine: InventoryStrategyProductLine) {
  return {
    marketValue: productLine.estimatedMarketValue,
    unitCount: productLine.unitCount,
  };
}

/** The product line's best cycle, or undefined without a curve or a profitable horizon. */
function productLineBestCycle(
  productLine: InventoryStrategyProductLine,
  economics: CapitalCycleEconomics,
): CapitalCycle | undefined {
  const model = productLine.horizonModel;
  return model?.curve
    ? bestCapitalCycle(
        model.curve,
        cyclePortfolio(productLine),
        economics,
        model,
      )
    : undefined;
}

function cycleSummary(
  overall: InventoryStrategyProductLine,
  cycle: CapitalCycle | undefined,
): string {
  if (!overall.horizonModel?.curve)
    return "All listed inventory has no horizon model yet.";
  if (!cycle)
    return "No profitable cycle on all listed inventory at these inputs.";
  if (cycle.dailyReturn === undefined)
    return "The best cycle on all listed inventory puts no capital at risk at these inputs, so it has no rate of return.";
  return `The best cycle on all listed inventory compounds capital at ${(cycle.dailyReturn * 100).toFixed(2)}% per day.`;
}

/**
 * Modeled value at one horizon with its marginal rate, elasticity, and the
 * profit per day of a capital cycle. Shows the horizon itself when it varies
 * by row (knee, best cycle, value-matched).
 */
function HorizonValueCell({
  productLine,
  horizonDays,
  economics,
  showDays = false,
  emphasis,
}: {
  productLine: InventoryStrategyProductLine;
  horizonDays: number | null;
  economics: CapitalCycleEconomics;
  showDays?: boolean;
  emphasis?: "active" | "knee" | "cycle";
}) {
  const model = productLine.horizonModel;
  if (!model?.curve || horizonDays === null) {
    return <TableCell align="right">—</TableCell>;
  }
  const outsideRange =
    horizonDays < model.minimumHorizonDays ||
    horizonDays > model.maximumHorizonDays;
  const cycle = capitalCycleAtHorizon(
    model.curve,
    cyclePortfolio(productLine),
    economics,
    horizonDays,
  );
  return (
    <TableCell
      align="right"
      sx={{ bgcolor: emphasis === "active" ? "action.selected" : undefined }}
    >
      {showDays && (
        <Typography
          variant="body2"
          fontWeight={700}
          color={emphasis ? emphasisColor[emphasis] : "text.primary"}
        >
          {formatDays(horizonDays)}
        </Typography>
      )}
      <Typography
        variant="body2"
        fontWeight={emphasis === "active" ? 700 : 400}
      >
        {currencyFormatter.format(horizonValue(model.curve, horizonDays))}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {currencyFormatter.format(
          horizonMarginalValuePerDay(model.curve, horizonDays),
        )}
        /day · e {horizonGainElasticity(model.curve, horizonDays).toFixed(2)}
      </Typography>
      <Typography
        variant="caption"
        display="block"
        color={cycle.profit >= 0 ? "text.secondary" : "error.main"}
      >
        {currencyFormatter.format(cycle.profitPerDay)}/day profit ·{" "}
        {currencyFormatter.format(cycle.netProceeds)} net
      </Typography>
      {outsideRange && (
        <Typography variant="caption" color="text.secondary" display="block">
          Outside curve range
        </Typography>
      )}
    </TableCell>
  );
}

export function HorizonCurve({
  dashboard,
}: {
  dashboard: InventoryStrategyDashboard;
}) {
  const [cycleInputs, setCycleInputs] = useState(DEFAULT_CAPITAL_CYCLE_INPUTS);
  const economics = useMemo<CapitalCycleEconomics>(
    () => ({
      ...cycleInputs,
      relativeOverhead: dashboard.profitPerDay.relativeOverhead,
      staticOverheadPerUnit: dashboard.profitPerDay.staticOverheadPerUnit,
    }),
    [cycleInputs, dashboard.profitPerDay],
  );
  const allProductLines = useMemo(
    () => [dashboard.overall, ...dashboard.productLines],
    [dashboard.overall, dashboard.productLines],
  );
  const activeHorizonDays =
    dashboard.policy.method === "target-horizon"
      ? dashboard.policy.horizonDays
      : null;
  const showValueMatchedColumn = allProductLines.some(
    (productLine) => productLine.valueMatchedHorizonDays !== null,
  );
  const bestCycles = useMemo(
    () =>
      Object.fromEntries(
        allProductLines.map((productLine) => [
          productLine.key,
          productLineBestCycle(productLine, economics),
        ]),
      ),
    [allProductLines, economics],
  );

  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Horizon curve</Typography>
        <Typography variant="body2" color="text.secondary">
          Physical value across target horizons follows a fitted log-logistic
          curve: floor plus headroom ÷ (1 + (midpoint ÷ horizon)^steepness). The
          knee is where gain per doubling of horizon decelerates fastest, at
          about 79% of headroom. Each cell shows modeled value, dollars per
          extra day, and elasticity (percent of gain over floor earned per
          percent longer horizon). Fit residual is the root-mean-square error in
          headroom fraction.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Profit per day takes overhead off the sale, recovers the cost basis,
          and divides by horizon plus turnaround. Best cycle is the horizon that
          maximizes it. Overhead comes from the profit-per-day settings.
          Horizons shorter than most SKUs&apos; fastest sell time overstate how
          quickly a cycle completes.
        </Typography>
        <Stack
          direction="row"
          spacing={2}
          flexWrap="wrap"
          useFlexGap
          sx={{ mt: 2 }}
        >
          {CAPITAL_CYCLE_FIELDS.map((field) => (
            <ValidatedNumberField
              key={field.key}
              size="small"
              label={field.label}
              value={cycleInputs[field.key]}
              step={field.step}
              helperText={field.helperText}
              isValid={(value) => value >= 0}
              onCommit={(value) =>
                setCycleInputs((current) => ({
                  ...current,
                  [field.key]: value,
                }))
              }
            />
          ))}
        </Stack>
        <Typography variant="body2" sx={{ mt: 2 }}>
          {cycleSummary(dashboard.overall, bestCycles[dashboard.overall.key])}{" "}
          The default profit-per-day hurdle is configured at{" "}
          {(dashboard.profitPerDay.dailyReturnHurdle * 100).toFixed(2)}% per
          day.
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small" sx={{ minWidth: 1200 }}>
          <TableHead>
            <TableRow>
              <TableCell
                sx={{
                  position: "sticky",
                  left: 0,
                  bgcolor: "background.paper",
                  zIndex: 1,
                }}
              >
                Product line
              </TableCell>
              <TableCell>Fit</TableCell>
              <TableCell align="right">Floor → ceiling</TableCell>
              <TableCell align="right">Knee</TableCell>
              <TableCell align="right">Best cycle</TableCell>
              {activeHorizonDays !== null && (
                <TableCell align="right">
                  Active ({formatDays(activeHorizonDays)})
                </TableCell>
              )}
              {showValueMatchedColumn && (
                <TableCell align="right">Value-matched</TableCell>
              )}
              {INVENTORY_STRATEGY_HORIZON_DAYS.map((horizonDays) => (
                <TableCell key={horizonDays} align="right">
                  {horizonDays} days
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {allProductLines.map((productLine) => {
              const model = productLine.horizonModel;
              const curve = model?.curve ?? null;
              return (
                <TableRow key={productLine.key}>
                  <TableCell
                    sx={{
                      position: "sticky",
                      left: 0,
                      bgcolor: "background.paper",
                      zIndex: 1,
                      fontWeight: productLine.key === "all" ? 700 : 400,
                    }}
                  >
                    {productLine.productLine}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={
                        model
                          ? fitConfidenceColor[model.fitConfidence]
                          : "default"
                      }
                      label={
                        !model
                          ? "No curve"
                          : !curve
                            ? "No fit"
                            : `${model.fitConfidence} confidence`
                      }
                    />
                    {curve && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                      >
                        midpoint {formatDays(curve.midpointDays)} · steepness{" "}
                        {curve.steepness.toFixed(2)} · residual{" "}
                        {curve.residual.toFixed(3)}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {model && curve ? (
                      <>
                        <Typography variant="body2">
                          {currencyFormatter.format(curve.floorValue)} →{" "}
                          {currencyFormatter.format(curve.ceilingValue)}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          display="block"
                        >
                          {formatDays(model.minimumHorizonDays)} –{" "}
                          {formatDays(model.maximumHorizonDays)}
                        </Typography>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <HorizonValueCell
                    productLine={productLine}
                    horizonDays={curve ? horizonKneeDays(curve) : null}
                    economics={economics}
                    showDays
                    emphasis="knee"
                  />
                  <HorizonValueCell
                    productLine={productLine}
                    horizonDays={
                      bestCycles[productLine.key]?.horizonDays ?? null
                    }
                    economics={economics}
                    showDays
                    emphasis="cycle"
                  />
                  {activeHorizonDays !== null && (
                    <HorizonValueCell
                      productLine={productLine}
                      horizonDays={activeHorizonDays}
                      economics={economics}
                      emphasis="active"
                    />
                  )}
                  {showValueMatchedColumn && (
                    <HorizonValueCell
                      productLine={productLine}
                      horizonDays={productLine.valueMatchedHorizonDays}
                      economics={economics}
                      showDays
                    />
                  )}
                  {INVENTORY_STRATEGY_HORIZON_DAYS.map((horizonDays) => (
                    <HorizonValueCell
                      key={horizonDays}
                      productLine={productLine}
                      horizonDays={horizonDays}
                      economics={economics}
                    />
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
