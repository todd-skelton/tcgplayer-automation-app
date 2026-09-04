import {
  Box,
  Chip,
  Paper,
  Slider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import {
  INVENTORY_STRATEGY_MAX_PERCENTILE,
  INVENTORY_STRATEGY_MIN_PERCENTILE,
  type InventoryStrategyProductLine,
  type InventoryStrategyScenario,
} from "../types/inventoryStrategy";
import {
  currencyFormatter,
  formatAge,
  formatCoverage,
  formatDelta,
  formatPercentile,
} from "./format";
import { findScenario, formatKneeEstimate } from "./scenarioSelection";

/** One product line with the percentile the reader chose and its scenario. */
export interface ScenarioSelection {
  productLine: InventoryStrategyProductLine;
  percentile: number;
  scenario: InventoryStrategyScenario | undefined;
}

export function ScenarioBuilder({
  selections,
  onSelect,
}: {
  selections: ScenarioSelection[];
  onSelect: (productLineKey: string, percentile: number) => void;
}) {
  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Scenario builder</Typography>
        <Typography variant="body2" color="text.secondary">
          Unmodeled SKUs remain at their actual listed price. Value changes are
          compared with the current configured policy, not stale live prices.
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Product line</TableCell>
              <TableCell align="center">Configured</TableCell>
              <TableCell align="center">Scenario</TableCell>
              <TableCell align="right">Units</TableCell>
              <TableCell align="right">Actual value</TableCell>
              <TableCell align="right">Policy value</TableCell>
              <TableCell align="right">Scenario value</TableCell>
              <TableCell align="right">Value change</TableCell>
              <TableCell align="right">Expected wait</TableCell>
              <TableCell align="right">Knee score</TableCell>
              <TableCell align="right">Coverage</TableCell>
              <TableCell align="right">Oldest curve</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {selections.map(({ productLine, percentile, scenario }) => {
              const currentPolicyScenario =
                productLine.configuredPercentile === null
                  ? undefined
                  : findScenario(productLine, productLine.configuredPercentile);
              const medianDayDelta =
                scenario?.estimatedTime && currentPolicyScenario?.estimatedTime
                  ? scenario.estimatedTime.medianDays -
                    currentPolicyScenario.estimatedTime.medianDays
                  : null;
              return (
                <TableRow key={productLine.key} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">
                        {productLine.productLine}
                      </Typography>
                      {!productLine.pricingEligible && (
                        <Chip size="small" label="Analysis only" />
                      )}
                      {productLine.estimatedPercentile !== null && (
                        <Chip
                          size="small"
                          color="success"
                          variant="outlined"
                          label={formatKneeEstimate(productLine)}
                        />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="center">
                    {productLine.configuredPercentile === null
                      ? "Skipped"
                      : formatPercentile(productLine.configuredPercentile)}
                  </TableCell>
                  <TableCell align="center">
                    <Stack
                      direction="row"
                      spacing={1.5}
                      alignItems="center"
                      sx={{ minWidth: 220 }}
                    >
                      <Slider
                        aria-label={`${productLine.productLine} scenario percentile`}
                        min={INVENTORY_STRATEGY_MIN_PERCENTILE}
                        max={INVENTORY_STRATEGY_MAX_PERCENTILE}
                        step={1}
                        value={percentile}
                        valueLabelDisplay="auto"
                        valueLabelFormat={formatPercentile}
                        onChange={(_, value) =>
                          onSelect(
                            productLine.key,
                            Array.isArray(value) ? value[0] : value,
                          )
                        }
                      />
                      <Box sx={{ minWidth: 54, textAlign: "right" }}>
                        <Typography variant="body2" fontWeight={700}>
                          {formatPercentile(percentile)}
                        </Typography>
                        {(scenario?.interpolatedUnitCount ?? 0) > 0 && (
                          <Typography variant="caption" color="text.secondary">
                            {scenario?.interpolatedUnitCount.toLocaleString()}{" "}
                            units interpolated
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    {productLine.unitCount.toLocaleString()}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(productLine.currentListedValue)}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(productLine.currentPolicyValue)}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(
                      scenario?.listedValue ?? productLine.currentPolicyValue,
                    )}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      color:
                        (scenario?.deltaFromCurrentPolicy ?? 0) > 0
                          ? "success.main"
                          : (scenario?.deltaFromCurrentPolicy ?? 0) < 0
                            ? "error.main"
                            : "text.primary",
                    }}
                  >
                    {formatDelta(scenario?.deltaFromCurrentPolicy ?? 0)}
                  </TableCell>
                  <TableCell align="right">
                    {scenario?.estimatedTime
                      ? `${scenario.estimatedTime.medianDays.toFixed(1)}d median · ${scenario.estimatedTime.p75Days.toFixed(1)}d P75 · ${scenario.estimatedTime.p90Days.toFixed(1)}d P90${medianDayDelta === null ? "" : ` · ${medianDayDelta >= 0 ? "+" : ""}${medianDayDelta.toFixed(1)}d`}`
                      : "Not modeled"}
                  </TableCell>
                  <TableCell align="right">
                    {scenario?.kneeScore === null ||
                    scenario?.kneeScore === undefined
                      ? "—"
                      : scenario.kneeScore.toFixed(3)}
                  </TableCell>
                  <TableCell align="right">
                    {formatCoverage(
                      scenario?.modeledUnitCount ?? 0,
                      productLine.unitCount,
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {formatAge(productLine.oldestPricingAt)}
                  </TableCell>
                </TableRow>
              );
            })}
            {selections.length === 0 && (
              <TableRow>
                <TableCell colSpan={12} align="center">
                  Refresh inventory to populate the strategy dashboard.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
