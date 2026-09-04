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
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from "@mui/material";
import { useMemo, useState } from "react";
import {
  bestCapitalCycle,
  type CapitalCycle,
  type CapitalCycleEconomics,
} from "~/features/pricing/domain/capitalCycle";
import { horizonKneeDays } from "~/features/pricing/domain/horizonValueCurve";
import { ValidatedNumberField } from "~/shared/components/ValidatedNumberField";
import {
  INVENTORY_STRATEGY_HORIZON_DAYS,
  type InventoryStrategyDashboard,
  type InventoryStrategyProductLine,
} from "../types/inventoryStrategy";
import {
  CAPITAL_CYCLE_FIELDS,
  cyclePortfolio,
  type CapitalCycleInputs,
} from "./capitalCycleInputs";
import { currencyFormatter, formatDays } from "./format";
import { HorizonChart, type HorizonMark } from "./HorizonChart";
import {
  horizonPoint,
  sampleHorizonPoints,
  type HorizonPoint,
} from "./horizonPoints";

const CHART_SAMPLE_COUNT = 80;

const fitConfidenceColor = {
  high: "success",
  medium: "warning",
  low: "default",
  unavailable: "default",
} as const;

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

function fitLabel(productLine: InventoryStrategyProductLine): string {
  const model = productLine.horizonModel;
  return !model
    ? "No curve"
    : !model.curve
      ? "No fit"
      : `${model.fitConfidence} confidence`;
}

/** Horizon, value, and profit per day for a called-out horizon, or a dash. */
function HorizonCell({ point }: { point: HorizonPoint | undefined }) {
  return (
    <TableCell align="right">
      {point ? (
        <>
          <Typography variant="body2">
            {formatDays(point.horizonDays)} ·{" "}
            {currencyFormatter.format(point.value)}
          </Typography>
          <Typography
            variant="caption"
            display="block"
            color={point.profit >= 0 ? "text.secondary" : "error.main"}
          >
            {currencyFormatter.format(point.profitPerDay)}/day profit
          </Typography>
        </>
      ) : (
        "—"
      )}
    </TableCell>
  );
}

export function HorizonCurve({
  dashboard,
  economics,
  cycleInputs,
  onCycleInputsChange,
}: {
  dashboard: InventoryStrategyDashboard;
  economics: CapitalCycleEconomics;
  cycleInputs: CapitalCycleInputs;
  onCycleInputsChange: (inputs: CapitalCycleInputs) => void;
}) {
  const theme = useTheme();
  const [selectedKey, setSelectedKey] = useState(dashboard.overall.key);
  const [tableView, setTableView] = useState(false);
  const allProductLines = useMemo(
    () => [dashboard.overall, ...dashboard.productLines],
    [dashboard.overall, dashboard.productLines],
  );
  const activeHorizonDays =
    dashboard.policy.method === "target-horizon"
      ? dashboard.policy.horizonDays
      : null;
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
  const selected =
    allProductLines.find((productLine) => productLine.key === selectedKey) ??
    dashboard.overall;
  const model = selected.horizonModel;
  const curve = model?.curve ?? null;
  const portfolio = cyclePortfolio(selected);
  const pointAt = (
    productLine: InventoryStrategyProductLine,
    days: number | null | undefined,
  ) =>
    productLine.horizonModel?.curve && days
      ? horizonPoint(
          productLine.horizonModel.curve,
          cyclePortfolio(productLine),
          economics,
          days,
        )
      : undefined;
  const markAt = (label: string, horizonDays: number, color: string) =>
    curve
      ? [
          {
            label,
            point: horizonPoint(curve, portfolio, economics, horizonDays),
            color,
          },
        ]
      : [];
  const marks: HorizonMark[] = curve
    ? [
        ...markAt("Knee", horizonKneeDays(curve), theme.palette.success.main),
        ...(bestCycles[selected.key]
          ? markAt(
              "Best cycle",
              bestCycles[selected.key]!.horizonDays,
              theme.palette.info.main,
            )
          : []),
        ...(activeHorizonDays !== null
          ? markAt("Active", activeHorizonDays, theme.palette.text.primary)
          : []),
      ]
    : [];
  const points =
    curve && model
      ? sampleHorizonPoints(
          curve,
          model,
          portfolio,
          economics,
          CHART_SAMPLE_COUNT,
        )
      : [];
  const tableRows = curve
    ? [
        ...marks.map(({ label, point }) => ({ label, point })),
        ...INVENTORY_STRATEGY_HORIZON_DAYS.map((horizonDays) => ({
          label: `${horizonDays} days`,
          point: horizonPoint(curve, portfolio, economics, horizonDays),
        })),
      ].sort((left, right) => left.point.horizonDays - right.point.horizonDays)
    : [];

  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Horizon curve</Typography>
        <Typography variant="body2" color="text.secondary">
          Physical value with every modeled SKU priced to sell within one target
          horizon, on a fitted log-logistic curve, and the profit per day of a
          sell-and-rebuy cycle at that horizon: overhead off the sale, the cost
          basis recovered, divided by horizon plus turnaround. The knee is where
          gain per doubling of horizon slows fastest; the best cycle is the
          horizon with the most profit per day. Horizons shorter than most
          SKUs&apos; fastest sell time overstate how quickly a cycle completes.
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
                onCycleInputsChange({ ...cycleInputs, [field.key]: value })
              }
            />
          ))}
        </Stack>
        <Typography variant="body2" sx={{ mt: 2 }}>
          {cycleSummary(dashboard.overall, bestCycles[dashboard.overall.key])}{" "}
          Overhead comes from the profit-per-day settings.
        </Typography>
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mt: 2 }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={selected.key}
            onChange={(_, key: string | null) => {
              if (key !== null) setSelectedKey(key);
            }}
          >
            {allProductLines.map((productLine) => (
              <ToggleButton key={productLine.key} value={productLine.key}>
                {productLine.key === "all" ? "All" : productLine.productLine}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <ToggleButton
            size="small"
            value="table"
            selected={tableView}
            onChange={() => setTableView((current) => !current)}
          >
            Table
          </ToggleButton>
          <Chip
            size="small"
            variant="outlined"
            color={model ? fitConfidenceColor[model.fitConfidence] : "default"}
            label={fitLabel(selected)}
          />
          {curve && model && (
            <Typography variant="caption" color="text.secondary">
              midpoint {formatDays(curve.midpointDays)} · steepness{" "}
              {curve.steepness.toFixed(2)} · residual{" "}
              {curve.residual.toFixed(3)} ·{" "}
              {currencyFormatter.format(curve.floorValue)} →{" "}
              {currencyFormatter.format(curve.ceilingValue)} over{" "}
              {formatDays(model.minimumHorizonDays)} –{" "}
              {formatDays(model.maximumHorizonDays)}
            </Typography>
          )}
        </Stack>
        {points.length > 0 ? (
          <Box sx={{ mt: 2 }}>
            <HorizonChart
              points={points}
              marks={marks}
              label={`${selected.productLine}: physical value and cycle profit per day against target horizon`}
            />
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {selected.productLine} has no fitted horizon curve.
          </Typography>
        )}
      </Box>
      {tableView && tableRows.length > 0 && (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Horizon</TableCell>
                <TableCell align="right">Days</TableCell>
                <TableCell align="right">Value</TableCell>
                <TableCell align="right">Marginal / day</TableCell>
                <TableCell align="right">Elasticity</TableCell>
                <TableCell align="right">Profit / day</TableCell>
                <TableCell align="right">Net proceeds</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map(({ label, point }) => (
                <TableRow key={label}>
                  <TableCell>{label}</TableCell>
                  <TableCell align="right">
                    {formatDays(point.horizonDays)}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(point.value)}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(point.marginalValuePerDay)}
                  </TableCell>
                  <TableCell align="right">
                    {point.elasticity.toFixed(2)}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: point.profit >= 0 ? undefined : "error.main" }}
                  >
                    {currencyFormatter.format(point.profitPerDay)}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(point.netProceeds)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Product line</TableCell>
              <TableCell>Fit</TableCell>
              <TableCell align="right">Floor → ceiling</TableCell>
              <TableCell align="right">Knee</TableCell>
              <TableCell align="right">Best cycle</TableCell>
              {activeHorizonDays !== null && (
                <TableCell align="right">
                  Active ({formatDays(activeHorizonDays)})
                </TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {allProductLines.map((productLine) => {
              const lineCurve = productLine.horizonModel?.curve;
              return (
                <TableRow
                  key={productLine.key}
                  hover
                  selected={productLine.key === selected.key}
                  onClick={() => setSelectedKey(productLine.key)}
                  sx={{ cursor: "pointer" }}
                >
                  <TableCell
                    sx={{ fontWeight: productLine.key === "all" ? 700 : 400 }}
                  >
                    {productLine.productLine}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={
                        productLine.horizonModel
                          ? fitConfidenceColor[
                              productLine.horizonModel.fitConfidence
                            ]
                          : "default"
                      }
                      label={fitLabel(productLine)}
                    />
                  </TableCell>
                  <TableCell align="right">
                    {lineCurve
                      ? `${currencyFormatter.format(lineCurve.floorValue)} → ${currencyFormatter.format(lineCurve.ceilingValue)}`
                      : "—"}
                  </TableCell>
                  <HorizonCell
                    point={pointAt(
                      productLine,
                      lineCurve ? horizonKneeDays(lineCurve) : null,
                    )}
                  />
                  <HorizonCell
                    point={pointAt(
                      productLine,
                      bestCycles[productLine.key]?.horizonDays,
                    )}
                  />
                  {activeHorizonDays !== null && (
                    <HorizonCell
                      point={pointAt(productLine, activeHorizonDays)}
                    />
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
