import React from "react";
import {
  Box,
  Typography,
  Paper,
  Alert,
  Chip,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from "@mui/material";
import type { ProcessingSummary } from "../types/pricing";
import { useConfiguration } from "../hooks/useConfiguration";
import { formatProcessingTime } from "../utils/timeFormatting";

interface ProcessingSummaryComponentProps {
  summary: ProcessingSummary;
}

export const ProcessingSummaryComponent: React.FC<
  ProcessingSummaryComponentProps
> = ({ summary }) => {
  const { percentiles, config } = useConfiguration();
  const combinedQuantity = summary.totalQuantity + summary.totalAddQuantity;

  const renderRecordStatistics = () => (
    <Card sx={{ flex: 1, minWidth: 300 }}>
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
              <TableCell>Processed Successfully</TableCell>
              <TableCell align="right" sx={{ color: "success.main" }}>
                {summary.processedRows.toLocaleString()}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Skipped</TableCell>
              <TableCell align="right" sx={{ color: "warning.main" }}>
                {summary.skippedRows.toLocaleString()}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Errors</TableCell>
              <TableCell align="right" sx={{ color: "error.main" }}>
                {summary.errorRows.toLocaleString()}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  const renderQuantitySummary = () => (
    <Card sx={{ flex: 1, minWidth: 300 }}>
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
  );

  const renderPriceTotals = () => (
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
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>Market Price</TableCell>
              <TableCell align="right">
                {summary.totals.marketPrice.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}
              </TableCell>
              <TableCell align="right">
                {(
                  summary.totals.marketPrice / combinedQuantity || 0
                ).toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Low Price</TableCell>
              <TableCell align="right">
                {summary.totals.lowPrice.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}
              </TableCell>
              <TableCell align="right">
                {(
                  summary.totals.lowPrice / combinedQuantity || 0
                ).toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <strong>Marketplace Price</strong>
              </TableCell>
              <TableCell align="right">
                <strong>
                  {summary.totals.marketplacePrice.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                  })}
                </strong>
              </TableCell>
              <TableCell align="right">
                <strong>
                  {(
                    summary.totals.marketplacePrice / combinedQuantity || 0
                  ).toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                  })}
                </strong>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  const renderPercentileAnalysis = () => {
    // Create a combined list of percentiles including the selected one if it's not in the standard list
    const allPercentiles = [...percentiles];
    if (!percentiles.includes(summary.percentileUsed)) {
      allPercentiles.push(summary.percentileUsed);
      allPercentiles.sort((a, b) => a - b);
    }

    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Percentile Analysis
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Percentile</TableCell>
                  <TableCell align="right">Total Value</TableCell>
                  <TableCell align="right">% Difference from Market</TableCell>
                  <TableCell align="right">
                    <Box>
                      Historical Sales Velocity
                      <Typography
                        variant="caption"
                        display="block"
                        color="text.secondary"
                      >
                        Based on sales history
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    <Box>
                      Estimated Time to Sell
                      <Typography
                        variant="caption"
                        display="block"
                        color="text.secondary"
                      >
                        Market-adjusted with competition
                      </Typography>
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {allPercentiles.map((p) => {
                  const percentileKey = `${p}th`;
                  const totalValue =
                    summary.totals.percentiles[percentileKey] || 0;

                  // Calculate percentage difference from market (only for rows with market values)
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

                  const isCurrentPercentile = p === summary.percentileUsed;

                  return (
                    <TableRow
                      key={p}
                      sx={
                        isCurrentPercentile
                          ? { backgroundColor: "action.hover" }
                          : {}
                      }
                    >
                      <TableCell>
                        {isCurrentPercentile ? (
                          <strong>{p}th (Current)</strong>
                        ) : (
                          `${p}th`
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {isCurrentPercentile ? (
                          <strong>
                            {totalValue.toLocaleString("en-US", {
                              style: "currency",
                              currency: "USD",
                            })}
                          </strong>
                        ) : (
                          totalValue.toLocaleString("en-US", {
                            style: "currency",
                            currency: "USD",
                          })
                        )}
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
                        {isCurrentPercentile ? (
                          <strong>
                            {percentDiffFromMarket >= 0 ? "+" : ""}
                            {percentDiffFromMarket.toFixed(1)}%
                          </strong>
                        ) : (
                          `${
                            percentDiffFromMarket >= 0 ? "+" : ""
                          }${percentDiffFromMarket.toFixed(1)}%`
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {medianDays !== undefined ? (
                          isCurrentPercentile ? (
                            <strong>{`${medianDays.toFixed(1)} days`}</strong>
                          ) : (
                            `${medianDays.toFixed(1)} days`
                          )
                        ) : (
                          "N/A"
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {marketAdjustedDays !== undefined ? (
                          isCurrentPercentile ? (
                            <strong>{`${marketAdjustedDays.toFixed(
                              1
                            )} days`}</strong>
                          ) : (
                            `${marketAdjustedDays.toFixed(1)} days`
                          )
                        ) : (
                          <Typography variant="body2" color="text.disabled">
                            Not available
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    );
  };

  const renderTimeToSellSummary = () => (
    <Card sx={{ maxWidth: 500 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Time to Sell Summary
        </Typography>
        <Table size="small">
          <TableBody>
            <TableRow>
              <TableCell>Historical Sales Velocity (Days)</TableCell>
              <TableCell align="right">
                {`${summary.medianDaysToSell.historicalSalesVelocity.toFixed(
                  1
                )} days`}
              </TableCell>
            </TableRow>
            {summary.medianDaysToSell.estimatedTimeToSell !== undefined && (
              <TableRow>
                <TableCell>
                  <Box>
                    Estimated Time to Sell (Market-Adjusted)
                    <Typography
                      variant="caption"
                      display="block"
                      color="text.secondary"
                    >
                      Considers current market competition
                    </Typography>
                  </Box>
                </TableCell>
                <TableCell align="right">
                  {`${summary.medianDaysToSell.estimatedTimeToSell.toFixed(
                    1
                  )} days`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  const renderStatusChips = () => (
    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
      <Chip
        label={`✅ ${summary.processedRows.toLocaleString()} Prices Updated`}
        color="success"
        variant="filled"
      />
      {summary.skippedRows > 0 && (
        <Chip
          label={`⚠️ ${summary.skippedRows.toLocaleString()} Skipped (C- IDs or No Qty)`}
          color="warning"
          variant="outlined"
        />
      )}
      {summary.errorRows > 0 && (
        <Chip
          label={`❌ ${summary.errorRows.toLocaleString()} Errors`}
          color="error"
          variant="outlined"
        />
      )}
    </Box>
  );

  const renderAlerts = () => (
    <>
      {summary.successRate < config.pricing.successRateThreshold.low && (
        <Alert severity="warning">
          <Typography variant="body2">
            <strong>Low success rate detected.</strong> Common issues include
            invalid TCGPlayer IDs, network connectivity problems, or products
            with insufficient sales data. Consider reviewing the error messages
            in the output CSV.
          </Typography>
        </Alert>
      )}

      {summary.successRate >= config.pricing.successRateThreshold.high && (
        <Alert severity="success">
          <Typography variant="body2">
            <strong>Excellent processing results!</strong>{" "}
            {summary.successRate.toFixed(1)}% success rate indicates your
            inventory data is well-formatted and most products have sufficient
            market data.
          </Typography>
        </Alert>
      )}
    </>
  );

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Typography variant="h5" gutterBottom>
        Processing Summary
      </Typography>

      <Box sx={{ mb: 2 }}>
        <Typography variant="body1" gutterBottom>
          <strong>File:</strong> {summary.fileName}
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Processed on {new Date().toLocaleString()} using{" "}
          {summary.percentileUsed}th percentile
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Processing time: {formatProcessingTime(summary.processingTime)}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {/* Record Statistics and Quantity Summary */}
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          {renderRecordStatistics()}
          {renderQuantitySummary()}
        </Box>

        {/* Price Totals */}
        {renderPriceTotals()}

        {/* Percentile Analysis */}
        {renderPercentileAnalysis()}

        {/* Expected Days to Sell Summary */}
        {renderTimeToSellSummary()}

        {/* Status Chips */}
        {renderStatusChips()}

        {/* Alerts and Next Steps */}
        {renderAlerts()}
      </Box>
    </Paper>
  );
};
