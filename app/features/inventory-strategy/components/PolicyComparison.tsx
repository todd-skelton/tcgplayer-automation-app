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
import type { InventoryStrategyPolicyComparison } from "../types/inventoryStrategy";
import { currencyFormatter } from "./format";

export function PolicyComparison({
  comparisons,
}: {
  comparisons: InventoryStrategyPolicyComparison[];
}) {
  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Policy comparison</Typography>
        <Typography variant="body2" color="text.secondary">
          The active policy supplies continuous-pricing candidates; benchmark
          and calibration rows are read-only. One-copy value is the calibration
          basis; physical value keeps actual quantities.
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Policy</TableCell>
              <TableCell align="right">One-copy value</TableCell>
              <TableCell align="right">Physical value</TableCell>
              <TableCell align="right">Median / P90 wait</TableCell>
              <TableCell align="right">Raised / lowered / held</TableCell>
              <TableCell align="right">Modeled SKUs</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {comparisons.map((comparison) => (
              <TableRow key={comparison.key}>
                <TableCell>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2">{comparison.label}</Typography>
                    {comparison.role !== "current" && (
                      <Chip
                        size="small"
                        color={
                          comparison.role === "active"
                            ? "success"
                            : comparison.planState === "mixed"
                              ? "warning"
                              : "default"
                        }
                        variant="outlined"
                        label={
                          comparison.role === "active"
                            ? "Active"
                            : comparison.role === "benchmark"
                              ? "Benchmark"
                              : comparison.planState === "mixed"
                                ? "Mixed plans"
                                : comparison.matchStatus
                                  ? `Calibration · ${comparison.matchStatus}`
                                  : "Calibration"
                        }
                      />
                    )}
                  </Stack>
                </TableCell>
                <TableCell align="right">
                  {currencyFormatter.format(comparison.oneCopyValue)}
                </TableCell>
                <TableCell align="right">
                  {currencyFormatter.format(comparison.physicalValue)}
                </TableCell>
                <TableCell align="right">
                  {comparison.estimatedTime
                    ? `${comparison.estimatedTime.medianDays.toFixed(1)} / ${comparison.estimatedTime.p90Days.toFixed(1)} days`
                    : "N/A"}
                </TableCell>
                <TableCell align="right">
                  {comparison.raisedCount} / {comparison.loweredCount} /{" "}
                  {comparison.heldCount}
                </TableCell>
                <TableCell align="right">
                  {comparison.modeledSkuCount.toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
