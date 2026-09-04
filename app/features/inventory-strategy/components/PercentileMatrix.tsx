import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import type { InventoryStrategyProductLine } from "../types/inventoryStrategy";
import { currencyFormatter, formatPercentile } from "./format";
import { findScenario } from "./scenarioSelection";

export function PercentileMatrix({
  productLines,
}: {
  productLines: InventoryStrategyProductLine[];
}) {
  const matrixPercentiles = useMemo(
    () =>
      Array.from(
        new Set(
          productLines.flatMap((productLine) => productLine.matrixPercentiles),
        ),
      ).sort((left, right) => left - right),
    [productLines],
  );

  return (
    <Paper variant="outlined">
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Full percentile matrix</Typography>
        <Typography variant="body2" color="text.secondary">
          Each cell shows guarded listed value and unit-weighted median expected
          wait. Knee score is normalized value minus normalized time; the
          outlined cell is the stable estimated recommendation.
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
              {matrixPercentiles.map((percentile) => (
                <TableCell key={percentile} align="right">
                  {formatPercentile(percentile)}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {productLines.map((productLine) => (
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
                {matrixPercentiles.map((percentile) => {
                  const scenario = findScenario(productLine, percentile);
                  const configured =
                    productLine.configuredPercentile === percentile;
                  const estimated =
                    productLine.estimatedPercentile === percentile;
                  const mathematical =
                    productLine.mathematicalKneePercentile === percentile;
                  return (
                    <TableCell
                      key={percentile}
                      align="right"
                      sx={{
                        bgcolor: configured ? "action.selected" : undefined,
                        outline: estimated ? "2px solid" : undefined,
                        outlineColor: estimated ? "success.main" : undefined,
                        outlineOffset: estimated ? "-2px" : undefined,
                      }}
                    >
                      <Typography
                        variant="body2"
                        fontWeight={configured ? 700 : 400}
                      >
                        {scenario
                          ? currencyFormatter.format(scenario.listedValue)
                          : "—"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {scenario?.estimatedTime
                          ? `${scenario.estimatedTime.medianDays.toFixed(1)} days`
                          : "No time estimate"}
                      </Typography>
                      <Typography
                        variant="caption"
                        display="block"
                        color={estimated ? "success.main" : "text.secondary"}
                        fontWeight={estimated ? 700 : 400}
                      >
                        {scenario?.kneeScore === null ||
                        scenario?.kneeScore === undefined
                          ? "No knee score"
                          : `Score ${scenario.kneeScore.toFixed(3)}`}
                        {estimated ? " · Estimated" : ""}
                        {mathematical && !estimated ? " · Math knee" : ""}
                        {(scenario?.interpolatedUnitCount ?? 0) > 0
                          ? " · Interpolated"
                          : ""}
                      </Typography>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
