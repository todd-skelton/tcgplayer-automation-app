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
import { PERCENTILES, PRICING_CONSTANTS } from "../constants/pricing";

interface ProcessingSummaryComponentProps {
  summary: ProcessingSummary;
}

export const ProcessingSummaryComponent: React.FC<
  ProcessingSummaryComponentProps
> = ({ summary }) => {
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
                ${summary.totals.marketPrice.toFixed(2)}
              </TableCell>
              <TableCell align="right">
                $
                {(summary.totals.marketPrice / combinedQuantity || 0).toFixed(
                  2
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Low Price</TableCell>
              <TableCell align="right">
                ${summary.totals.lowPrice.toFixed(2)}
              </TableCell>
              <TableCell align="right">
                ${(summary.totals.lowPrice / combinedQuantity || 0).toFixed(2)}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <strong>Suggested Price</strong>
              </TableCell>
              <TableCell align="right">
                <strong>${summary.totals.marketplacePrice.toFixed(2)}</strong>
              </TableCell>
              <TableCell align="right">
                <strong>
                  $
                  {(
                    summary.totals.marketplacePrice / combinedQuantity || 0
                  ).toFixed(2)}
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
    const allPercentiles = [...PERCENTILES];
    if (!PERCENTILES.includes(summary.percentileUsed)) {
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
                  <TableCell align="right">Median Days to Sell</TableCell>
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
                    summary.medianDaysToSell.percentiles[percentileKey] || 0;

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
                          <strong>${totalValue.toFixed(2)}</strong>
                        ) : (
                          `$${totalValue.toFixed(2)}`
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
                        {medianDays > 0 ? (
                          isCurrentPercentile ? (
                            <strong>{medianDays.toFixed(1)} days</strong>
                          ) : (
                            `${medianDays.toFixed(1)} days`
                          )
                        ) : (
                          "N/A"
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
              <TableCell>Median Expected Days to Sell</TableCell>
              <TableCell align="right">
                {summary.medianDaysToSell.expectedDaysToSell > 0
                  ? `${summary.medianDaysToSell.expectedDaysToSell.toFixed(
                      1
                    )} days`
                  : "N/A"}
              </TableCell>
            </TableRow>
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
      {summary.successRate < PRICING_CONSTANTS.SUCCESS_RATE_THRESHOLD.LOW && (
        <Alert severity="warning">
          <Typography variant="body2">
            <strong>Low success rate detected.</strong> Common issues include
            invalid TCGPlayer IDs, network connectivity problems, or products
            with insufficient sales data. Consider reviewing the error messages
            in the output CSV.
          </Typography>
        </Alert>
      )}

      {summary.successRate >= PRICING_CONSTANTS.SUCCESS_RATE_THRESHOLD.HIGH && (
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
          Processing time: {(summary.processingTime / 1000).toFixed(1)} seconds
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
