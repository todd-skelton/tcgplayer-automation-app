import React, { useEffect } from "react";
import Papa from "papaparse";
import { useFetcher } from "react-router";
import { skusDb } from "~/datastores";
import {
  Box,
  Button,
  Typography,
  Paper,
  Alert,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from "@mui/material";
import { getSuggestedPriceFromLatestSales } from "~/algorithms/getSuggestedPriceFromLatestSales";

export interface TcgPlayerListing {
  "TCGplayer Id": string;
  "Product Line": string;
  "Set Name": string;
  "Product Name": string;
  Title: string;
  Number: string;
  Rarity: string;
  Condition: string;
  "TCG Market Price": string;
  "TCG Direct Low": string;
  "TCG Low Price With Shipping": string;
  "TCG Low Price": string;
  "Total Quantity": string;
  "Add to Quantity": string;
  "TCG Marketplace Price": string;
  "Photo URL": string;
  [key: string]: string;
}

// Note: The pricer action will add the following columns to the CSV output:
// - Previous Marketplace Price
// - Expected Days to Sell
// - Error
// - Price 0th Percentile, Price 10th Percentile, ..., Price 100th Percentile
// - Days to Sell 0th Percentile, Days to Sell 10th Percentile, ..., Days to Sell 100th Percentile

// Summary Interface
interface ProcessingSummary {
  totalRecords: number;
  processedRecords: number;
  skippedRecords: number;
  errorRecords: number;
  totalQuantity: number;
  totalAddQuantity: number;
  totals: {
    marketPrice: number;
    lowPrice: number;
    marketplacePrice: number;
    percentiles: { [key: string]: number };
  };
  // Track totals only for rows with market values
  totalsWithMarket: {
    marketPrice: number;
    percentiles: { [key: string]: number };
    quantityWithMarket: number; // Track quantity for rows that have market values
  };
  medianDaysToSell: {
    expectedDaysToSell: number;
    percentiles: { [key: string]: number };
  };
}

// React Router 7 server action
export async function action({ request }: { request: Request }) {
  const formData = await request.formData();
  const file = formData.get("csv");
  if (!file || typeof file === "string" || !("text" in file)) {
    console.log("No file uploaded");
    return new Response(JSON.stringify({ error: "No file uploaded" }), {
      status: 400,
    });
  }
  console.log("File upload received");
  const text = await file.text();
  const results = Papa.parse<TcgPlayerListing>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const rows = results.data;
  console.log(`Parsed ${rows.length} rows from CSV`);
  const updatedRows: TcgPlayerListing[] = [];
  // Initialize summary tracking
  const summary: ProcessingSummary = {
    totalRecords: rows.length,
    processedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    totalQuantity: 0,
    totalAddQuantity: 0,
    totals: {
      marketPrice: 0,
      lowPrice: 0,
      marketplacePrice: 0,
      percentiles: {},
    },
    totalsWithMarket: {
      marketPrice: 0,
      percentiles: {},
      quantityWithMarket: 0,
    },
    medianDaysToSell: {
      expectedDaysToSell: 0,
      percentiles: {},
    },
  };

  // Initialize percentile totals
  for (let p = 0; p <= 100; p += 10) {
    summary.totals.percentiles[`${p}th`] = 0;
    summary.totalsWithMarket.percentiles[`${p}th`] = 0;
    summary.medianDaysToSell.percentiles[`${p}th`] = 0;
  }

  // Arrays to collect values for median calculations
  const daysToSellValues: number[] = [];
  const percentileDaysValues: { [key: string]: number[] } = {};
  for (let p = 0; p <= 100; p += 10) {
    percentileDaysValues[`${p}th`] = [];
  }

  for (const [i, row] of rows.entries()) {
    // Initialize columns to ensure they appear in output CSV
    row["Previous Marketplace Price"] = row["TCG Marketplace Price"] || "";
    row["Expected Days to Sell"] = row["Expected Days to Sell"] || "";
    row["Error"] = row["Error"] || "";

    // Initialize percentile columns (0, 10, 20, ..., 100)
    for (let p = 0; p <= 100; p += 10) {
      row[`Price ${p}th Percentile`] = row[`Price ${p}th Percentile`] || "";
      row[`Days to Sell ${p}th Percentile`] =
        row[`Days to Sell ${p}th Percentile`] || "";
    }
    if (row["TCGplayer Id"].startsWith("C-")) {
      summary.skippedRecords++;
      continue;
    }

    // Only process rows with Total Quantity or Add to Quantity > 1
    const totalQty = Number(row["Total Quantity"]);
    const addQty = Number(row["Add to Quantity"]);
    if (!totalQty && !addQty) {
      summary.skippedRecords++;
      continue;
    }

    // Track quantities
    summary.totalQuantity += totalQty;
    summary.totalAddQuantity += addQty;

    const skuId = Number(row["TCGplayer Id"]);
    console.log(`Processing row ${i + 1}/${rows.length} (SKU: ${skuId})`);
    const sku = await skusDb.findOne({ sku: skuId });
    if (!sku) {
      console.log(
        `Row ${i + 1}: SKU ${skuId} (${
          row["Product Name"]
        }) not found in DB, skipping`
      );
      row["Error"] = `SKU ${skuId} not found in DB`;
      summary.errorRecords++;
      updatedRows.push(row);
      continue;
    }
    try {
      const latestSalesResult = await getSuggestedPriceFromLatestSales(sku, {
        percentile: 60,
      });

      // Populate percentile data columns
      if (
        latestSalesResult.percentiles &&
        latestSalesResult.percentiles.length > 0
      ) {
        latestSalesResult.percentiles.forEach((percentileData) => {
          row[`Price ${percentileData.percentile}th Percentile`] =
            percentileData.price.toFixed(2);
          if (percentileData.expectedTimeToSellDays !== undefined) {
            row[`Days to Sell ${percentileData.percentile}th Percentile`] =
              percentileData.expectedTimeToSellDays.toFixed(2);
          }
        });
      }

      // Keep backward compatibility for existing columns
      if (latestSalesResult.expectedTimeToSellDays) {
        row["Expected Days to Sell"] =
          latestSalesResult.expectedTimeToSellDays.toFixed(2);
      }
      if (latestSalesResult.suggestedPrice) {
        row["TCG Marketplace Price"] = Number(
          latestSalesResult.suggestedPrice
        ).toFixed(2);
      } else {
        row["Error"] = "No suggested price from latest sales";
        // Fallback: choose the lowest non-empty price among Market, Low, or current Marketplace
        const marketPrice = Number(row["TCG Market Price"]) || Infinity;
        const lowPrice = Number(row["TCG Low Price"]) || Infinity;
        const marketplacePrice =
          Number(row["TCG Marketplace Price"]) || Infinity;

        const minPrice = Math.min(marketPrice, lowPrice, marketplacePrice);
        if (minPrice !== Infinity)
          row["TCG Marketplace Price"] = minPrice.toFixed(2);
      }
      console.log(
        `Row ${i + 1}: SKU ${skuId} priced at ${
          row["TCG Marketplace Price"]
        } with ${latestSalesResult.percentiles?.length || 0} percentiles`
      ); // Track successful processing and collect data for summary
      summary.processedRecords++;

      // Add to price totals
      const marketPrice = Number(row["TCG Market Price"]) || 0;
      const lowPrice = Number(row["TCG Low Price"]) || 0;
      const marketplacePrice = Number(row["TCG Marketplace Price"]) || 0;

      summary.totals.marketPrice += marketPrice * (totalQty + addQty);
      summary.totals.lowPrice += lowPrice * (totalQty + addQty);
      summary.totals.marketplacePrice += marketplacePrice * (totalQty + addQty);

      // Track totals only for rows with market values (for percentage calculations)
      const hasMarketValue = marketPrice > 0;
      if (hasMarketValue) {
        summary.totalsWithMarket.marketPrice +=
          marketPrice * (totalQty + addQty);
        summary.totalsWithMarket.quantityWithMarket += totalQty + addQty;

        // Add percentile totals only for rows with market values
        for (let p = 0; p <= 100; p += 10) {
          const percentilePrice = Number(row[`Price ${p}th Percentile`]) || 0;
          summary.totalsWithMarket.percentiles[`${p}th`] +=
            percentilePrice * (totalQty + addQty);
        }
      }

      // Collect days to sell for median calculation
      const expectedDays = Number(row["Expected Days to Sell"]) || 0;
      if (expectedDays > 0) {
        daysToSellValues.push(expectedDays);
      }

      // Add percentile totals and collect days data
      for (let p = 0; p <= 100; p += 10) {
        const percentilePrice = Number(row[`Price ${p}th Percentile`]) || 0;
        const percentileDays =
          Number(row[`Days to Sell ${p}th Percentile`]) || 0;

        summary.totals.percentiles[`${p}th`] +=
          percentilePrice * (totalQty + addQty);

        if (percentileDays > 0) {
          percentileDaysValues[`${p}th`].push(percentileDays);
        }
      }
      updatedRows.push(row);
    } catch (err: any) {
      row["Error"] = `Error getting suggested price: ${err?.message || err}`;
      summary.errorRecords++;
      updatedRows.push(row);
      continue;
    }
  }
  console.log("All rows processed, generating CSV");

  // Calculate medians for days to sell
  const calculateMedian = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = values.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  summary.medianDaysToSell.expectedDaysToSell =
    calculateMedian(daysToSellValues);

  for (let p = 0; p <= 100; p += 10) {
    summary.medianDaysToSell.percentiles[`${p}th`] = calculateMedian(
      percentileDaysValues[`${p}th`]
    );
  }

  console.log("Summary:", JSON.stringify(summary, null, 2));

  const csv = Papa.unparse(updatedRows);

  // Return both CSV and summary data
  return new Response(JSON.stringify({ csv, summary }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export default function PricerRoute() {
  const { Form, state, data } = useFetcher();
  const processing = state === "submitting";

  useEffect(() => {
    if (data && typeof data === "object" && data.csv && data.summary) {
      // New format: JSON response with CSV and summary
      const blob = new Blob([data.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `priced-listings-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } else if (
      data &&
      typeof data === "string" &&
      (data.startsWith("\uFEFF")
        ? data.slice(1, 20).includes(",")
        : data.includes(","))
    ) {
      // Legacy format: CSV string (fallback)
      const blob = new Blob([data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `priced-listings-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }
  }, [data]);
  return (
    <Box sx={{ p: 3 }}>
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h4" gutterBottom>
          TCGPlayer CSV Pricer
        </Typography>
        <Form method="post" encType="multipart/form-data">
          <input
            type="file"
            name="csv"
            accept=".csv"
            required
            style={{ marginBottom: 16 }}
          />
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={processing}
            sx={{ ml: 2 }}
          >
            {processing ? "Processing..." : "Upload and Price CSV"}
          </Button>
        </Form>
      </Paper>

      {data && data.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography>{data.error}</Typography>
        </Alert>
      )}
      {data && data.summary && (
        <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
          <Typography variant="h5" gutterBottom>
            Processing Summary
          </Typography>

          <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {/* Record Statistics */}
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
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
                          {data.summary.totalRecords}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Processed Successfully</TableCell>
                        <TableCell align="right" sx={{ color: "success.main" }}>
                          {data.summary.processedRecords}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Skipped</TableCell>
                        <TableCell align="right" sx={{ color: "warning.main" }}>
                          {data.summary.skippedRecords}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Errors</TableCell>
                        <TableCell align="right" sx={{ color: "error.main" }}>
                          {data.summary.errorRecords}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Quantity Summary */}
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
                          {data.summary.totalQuantity}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Add to Quantity</TableCell>
                        <TableCell align="right">
                          {data.summary.totalAddQuantity}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>
                          <strong>Combined Total</strong>
                        </TableCell>
                        <TableCell align="right">
                          <strong>
                            {data.summary.totalQuantity +
                              data.summary.totalAddQuantity}
                          </strong>
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </Box>
            {/* Price Totals */}
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
                        ${data.summary.totals.marketPrice.toFixed(2)}
                      </TableCell>
                      <TableCell align="right">
                        $
                        {(
                          data.summary.totals.marketPrice /
                            (data.summary.totalQuantity +
                              data.summary.totalAddQuantity) || 0
                        ).toFixed(2)}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Low Price</TableCell>
                      <TableCell align="right">
                        ${data.summary.totals.lowPrice.toFixed(2)}
                      </TableCell>
                      <TableCell align="right">
                        $
                        {(
                          data.summary.totals.lowPrice /
                            (data.summary.totalQuantity +
                              data.summary.totalAddQuantity) || 0
                        ).toFixed(2)}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>
                        <strong>Marketplace Price</strong>
                      </TableCell>
                      <TableCell align="right">
                        <strong>
                          ${data.summary.totals.marketplacePrice.toFixed(2)}
                        </strong>
                      </TableCell>
                      <TableCell align="right">
                        <strong>
                          $
                          {(
                            data.summary.totals.marketplacePrice /
                              (data.summary.totalQuantity +
                                data.summary.totalAddQuantity) || 0
                          ).toFixed(2)}
                        </strong>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>{" "}
            {/* Percentile Analysis */}
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
                        <TableCell align="right">
                          % Difference from Market
                        </TableCell>
                        <TableCell align="right">Median Days to Sell</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => {
                        const percentileKey = `${p}th`;
                        const totalValue =
                          data.summary.totals.percentiles[percentileKey] || 0;

                        // Calculate percentage difference from market (only for rows with market values)
                        const percentileValueWithMarket =
                          data.summary.totalsWithMarket.percentiles[
                            percentileKey
                          ] || 0;
                        const marketValueWithMarket =
                          data.summary.totalsWithMarket.marketPrice || 0;
                        const percentDiffFromMarket =
                          marketValueWithMarket > 0
                            ? ((percentileValueWithMarket -
                                marketValueWithMarket) /
                                marketValueWithMarket) *
                              100
                            : 0;

                        const medianDays =
                          data.summary.medianDaysToSell.percentiles[
                            percentileKey
                          ] || 0;

                        return (
                          <TableRow
                            key={p}
                            sx={
                              p === 70
                                ? { backgroundColor: "action.hover" }
                                : {}
                            }
                          >
                            <TableCell>
                              {p === 70 ? (
                                <strong>{p}th (Current)</strong>
                              ) : (
                                `${p}th`
                              )}
                            </TableCell>
                            <TableCell align="right">
                              {p === 70 ? (
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
                              {p === 70 ? (
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
                                p === 70 ? (
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
            {/* Expected Days to Sell Summary */}
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
                        {data.summary.medianDaysToSell.expectedDaysToSell > 0
                          ? `${data.summary.medianDaysToSell.expectedDaysToSell.toFixed(
                              1
                            )} days`
                          : "N/A"}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </Box>
        </Paper>
      )}
    </Box>
  );
}
