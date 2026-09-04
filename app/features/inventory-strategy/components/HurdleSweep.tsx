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
import type { InventoryStrategyDashboard } from "../types/inventoryStrategy";
import { currencyFormatter, formatHurdle } from "./format";

export function HurdleSweep({
  dashboard,
}: {
  dashboard: InventoryStrategyDashboard;
}) {
  const productLines = [dashboard.overall, ...dashboard.productLines];
  const hurdles = Array.from(
    new Set(
      productLines.flatMap((productLine) =>
        productLine.hurdleSweep.map((scenario) => scenario.dailyReturnHurdle),
      ),
    ),
  ).sort((left, right) => left - right);

  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Hurdle sweep</Typography>
        <Typography variant="body2" color="text.secondary">
          Profit per day prices each SKU where its net proceeds, discounted at
          the daily return hurdle over its expected wait, are highest. Each cell
          shows the physical value at that hurdle, the median and P90 wait, and
          how many SKUs it raises and lowers against their listed prices. The
          shaded cell is the hurdle the product line is configured with; all
          listed inventory applies one hurdle to every product line.
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Product line</TableCell>
              {hurdles.map((hurdle) => (
                <TableCell key={hurdle} align="right">
                  {formatHurdle(hurdle)}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {productLines.map((productLine) => (
              <TableRow key={productLine.key}>
                <TableCell
                  sx={{ fontWeight: productLine.key === "all" ? 700 : 400 }}
                >
                  {productLine.productLine}
                </TableCell>
                {hurdles.map((hurdle) => {
                  const scenario = productLine.hurdleSweep.find(
                    (candidate) => candidate.dailyReturnHurdle === hurdle,
                  );
                  return (
                    <TableCell
                      key={hurdle}
                      align="right"
                      sx={{
                        bgcolor: scenario?.configured
                          ? "action.selected"
                          : undefined,
                      }}
                    >
                      {scenario ? (
                        <>
                          <Typography
                            variant="body2"
                            fontWeight={scenario.configured ? 700 : 400}
                          >
                            {currencyFormatter.format(scenario.physicalValue)}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                          >
                            {scenario.estimatedTime
                              ? `${scenario.estimatedTime.medianDays.toFixed(1)} / ${scenario.estimatedTime.p90Days.toFixed(1)} days`
                              : "No wait estimate"}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                          >
                            ↑ {scenario.raisedCount.toLocaleString()} · ↓{" "}
                            {scenario.loweredCount.toLocaleString()}
                          </Typography>
                        </>
                      ) : (
                        "—"
                      )}
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
