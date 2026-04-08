import React from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useConfiguration } from "~/features/pricing/hooks/useConfiguration";
import type { InventoryBatchSummary } from "../types/inventoryBatch";

interface InventoryBatchSummaryComponentProps {
  summary: InventoryBatchSummary;
  lastPricedAt?: Date | string | null;
}

function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatPercentileList(percentilesUsed?: number[]): string {
  if (!percentilesUsed || percentilesUsed.length === 0) {
    return "N/A";
  }

  return percentilesUsed.map((percentile) => `${percentile}th`).join(", ");
}

function getAveragePerUnit(totalValue: number, combinedQuantity: number): number {
  return combinedQuantity > 0 ? totalValue / combinedQuantity : 0;
}

function getPercentDiffFromMarket(
  value: number,
  marketValue: number,
): number | null {
  if (marketValue <= 0) {
    return null;
  }

  return ((value - marketValue) / marketValue) * 100;
}

export const InventoryBatchSummaryComponent: React.FC<
  InventoryBatchSummaryComponentProps
> = ({ summary, lastPricedAt }) => {
  const { config } = useConfiguration();
  const manualReviewRows = summary.manualReviewRows ?? 0;
  const combinedQuantity = summary.totalQuantity + summary.totalAddQuantity;
  const percentileKeys = Object.keys(summary.totals.percentiles)
    .map((key) => Number.parseInt(key.replace("th", ""), 10))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b);
  const productLines = Object.entries(summary.productLineBreakdown ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productLineName, data]) => ({
      productLineName,
      count: data.count,
      percentilesUsed:
        "percentilesUsed" in data
          ? data.percentilesUsed
          : "percentileUsed" in (data as { percentileUsed?: number })
            ? [
                (data as { percentileUsed?: number }).percentileUsed,
              ].filter((value): value is number => value !== undefined)
            : [],
      totalValue: data.totalValue,
    }));
  const marketComparableMarketValue = summary.totalsWithMarket.marketPrice || 0;
  const lowPricePercentDiff = getPercentDiffFromMarket(
    summary.totalsWithMarket.lowPrice ?? 0,
    marketComparableMarketValue,
  );
  const marketplacePricePercentDiff = getPercentDiffFromMarket(
    summary.totalsWithMarket.marketplacePrice ?? 0,
    marketComparableMarketValue,
  );

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Typography variant="h5" gutterBottom>
        Batch Summary
      </Typography>

      <Box sx={{ mb: 2 }}>
        <Typography variant="body1" gutterBottom>
          <strong>Batch:</strong> {summary.fileName}
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Current aggregate for the saved batch pricing results.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Last priced:{" "}
          {lastPricedAt ? new Date(lastPricedAt).toLocaleString() : "Not yet priced"}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          <Card sx={{ flex: 1, minWidth: 320 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Record Statistics
              </Typography>
              <Table size="small">
                <TableBody>
                  <TableRow>
                    <TableCell>Total Records</TableCell>
                    <TableCell align="right">
                      {summary.totalRows.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Successfully Priced</TableCell>
                    <TableCell align="right" sx={{ color: "success.main" }}>
                      {summary.processedRows.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Manual Review / Errors</TableCell>
                    <TableCell align="right" sx={{ color: "warning.main" }}>
                      {manualReviewRows.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Not Yet Priced</TableCell>
                    <TableCell align="right">
                      {summary.skippedRows.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Rows With Errors</TableCell>
                    <TableCell align="right" sx={{ color: "error.main" }}>
                      {summary.errorRows.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Rows With Warnings</TableCell>
                    <TableCell align="right" sx={{ color: "warning.main" }}>
                      {summary.warningRows.toLocaleString()}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card sx={{ flex: 1, minWidth: 320 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Quantity Summary
              </Typography>
              <Table size="small">
                <TableBody>
                  <TableRow>
                    <TableCell>Total Quantity</TableCell>
                    <TableCell align="right">
                      {summary.totalQuantity.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Add to Quantity</TableCell>
                    <TableCell align="right">
                      {summary.totalAddQuantity.toLocaleString()}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>
                      <strong>Combined Total</strong>
                    </TableCell>
                    <TableCell align="right">
                      <strong>{combinedQuantity.toLocaleString()}</strong>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Box>

        {productLines.length > 0 && (
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Product Line Breakdown
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Current successful rows grouped by product line.
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Product Line</TableCell>
                      <TableCell align="center">Items</TableCell>
                      <TableCell align="center">Percentiles Used</TableCell>
                      <TableCell align="right">Total Value</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {productLines.map((data) => (
                      <TableRow key={data.productLineName}>
                        <TableCell>{data.productLineName}</TableCell>
                        <TableCell align="center">
                          {data.count.toLocaleString()}
                        </TableCell>
                        <TableCell align="center">
                          {formatPercentileList(data.percentilesUsed)}
                        </TableCell>
                        <TableCell align="right">
                          {formatCurrency(data.totalValue)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Price Totals (Weighted by Quantity)
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Price Type</TableCell>
                  <TableCell align="right">Total Value</TableCell>
                  <TableCell align="right">Average per Unit</TableCell>
                  <TableCell align="right">% vs Market</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <TableRow>
                  <TableCell>Market Price</TableCell>
                  <TableCell align="right">
                    {formatCurrency(summary.totals.marketPrice)}
                  </TableCell>
                  <TableCell align="right">
                    {formatCurrency(
                      getAveragePerUnit(summary.totals.marketPrice, combinedQuantity),
                    )}
                  </TableCell>
                  <TableCell align="right">0.0%</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Low Price</TableCell>
                  <TableCell align="right">
                    {formatCurrency(summary.totals.lowPrice)}
                  </TableCell>
                  <TableCell align="right">
                    {formatCurrency(
                      getAveragePerUnit(summary.totals.lowPrice, combinedQuantity),
                    )}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      color:
                        lowPricePercentDiff === null
                          ? "text.secondary"
                          : lowPricePercentDiff > 0
                            ? "success.main"
                            : lowPricePercentDiff < 0
                              ? "error.main"
                              : "text.primary",
                    }}
                  >
                    {lowPricePercentDiff === null
                      ? "Not available"
                      : `${lowPricePercentDiff >= 0 ? "+" : ""}${lowPricePercentDiff.toFixed(1)}%`}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>
                    <strong>Marketplace Price</strong>
                  </TableCell>
                  <TableCell align="right">
                    <strong>{formatCurrency(summary.totals.marketplacePrice)}</strong>
                  </TableCell>
                  <TableCell align="right">
                    <strong>
                      {formatCurrency(
                        getAveragePerUnit(
                          summary.totals.marketplacePrice,
                          combinedQuantity,
                        ),
                      )}
                    </strong>
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      color:
                        marketplacePricePercentDiff === null
                          ? "text.secondary"
                          : marketplacePricePercentDiff > 0
                            ? "success.main"
                            : marketplacePricePercentDiff < 0
                              ? "error.main"
                              : "text.primary",
                    }}
                  >
                    <strong>
                      {marketplacePricePercentDiff === null
                        ? "Not available"
                        : `${marketplacePricePercentDiff >= 0 ? "+" : ""}${marketplacePricePercentDiff.toFixed(1)}%`}
                    </strong>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {percentileKeys.length > 0 && (
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Percentile Analysis
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Rebuilt from the saved pricing details on successful rows.
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Percentile</TableCell>
                      <TableCell align="right">Total Value</TableCell>
                      <TableCell align="right">% Difference from Market</TableCell>
                      <TableCell align="right">Historical Sales Velocity</TableCell>
                      <TableCell align="right">Estimated Time to Sell</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {percentileKeys.map((percentile) => {
                      const percentileKey = `${percentile}th`;
                      const totalValue = summary.totals.percentiles[percentileKey] || 0;
                      const percentileValueWithMarket =
                        summary.totalsWithMarket.percentiles[percentileKey] || 0;
                      const marketValueWithMarket =
                        summary.totalsWithMarket.marketPrice || 0;
                      const percentDiffFromMarket =
                        marketValueWithMarket > 0
                          ? ((percentileValueWithMarket - marketValueWithMarket) /
                              marketValueWithMarket) *
                            100
                          : 0;
                      const medianDays =
                        summary.medianDaysToSell.percentiles[percentileKey];
                      const marketAdjustedDays =
                        summary.medianDaysToSell.marketAdjustedPercentiles?.[
                          percentileKey
                        ];

                      return (
                        <TableRow key={percentileKey}>
                          <TableCell>{percentileKey}</TableCell>
                          <TableCell align="right">
                            {formatCurrency(totalValue)}
                          </TableCell>
                          <TableCell
                            align="right"
                            sx={{
                              color:
                                percentDiffFromMarket > 0
                                  ? "success.main"
                                  : percentDiffFromMarket < 0
                                    ? "error.main"
                                    : "text.primary",
                            }}
                          >
                            {percentDiffFromMarket >= 0 ? "+" : ""}
                            {percentDiffFromMarket.toFixed(1)}%
                          </TableCell>
                          <TableCell align="right">
                            {medianDays !== undefined
                              ? `${medianDays.toFixed(1)} days`
                              : "N/A"}
                          </TableCell>
                          <TableCell align="right">
                            {marketAdjustedDays !== undefined
                              ? `${marketAdjustedDays.toFixed(1)} days`
                              : "Not available"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        )}

        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Chip
            label={`${summary.processedRows.toLocaleString()} successful`}
            color="success"
            variant="filled"
          />
          <Chip
            label={`${manualReviewRows.toLocaleString()} manual review`}
            color="warning"
            variant="outlined"
          />
          {summary.skippedRows > 0 && (
            <Chip
              label={`${summary.skippedRows.toLocaleString()} not yet priced`}
              variant="outlined"
            />
          )}
          {summary.warningRows > 0 && (
            <Chip
              label={`${summary.warningRows.toLocaleString()} rows with warnings`}
              color="warning"
              variant="outlined"
            />
          )}
        </Box>

        {summary.successRate < config.pricing.successRateThreshold.low && (
          <Alert severity="warning">
            <Typography variant="body2">
              The batch still has a low success rate. Repricing remaining manual
              review rows may improve the final batch output.
            </Typography>
          </Alert>
        )}

        {summary.successRate >= config.pricing.successRateThreshold.high && (
          <Alert severity="success">
            <Typography variant="body2">
              The batch is in good shape with {summary.successRate.toFixed(1)}%
              of rows currently priced successfully.
            </Typography>
          </Alert>
        )}
      </Box>
    </Paper>
  );
};

