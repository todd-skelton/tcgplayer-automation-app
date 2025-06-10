import React, { useEffect } from "react";
import Papa from "papaparse";
import { useFetcher } from "react-router";
import { skusDb } from "~/datastores";
import { Box, Button, Typography, Paper, Alert } from "@mui/material";
import { getVolumeBasedSuggestedPriceForSku } from "~/algorithms/getVolumeBasedSuggestedPriceForSku";
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
  for (const [i, row] of rows.entries()) {
    // Initialize columns to ensure they appear in output CSV
    row["Previous Marketplace Price"] = row["TCG Marketplace Price"] || "";
    row["Error"] = row["Error"] || "";

    // Only process rows with Total Quantity or Add to Quantity > 1
    const totalQty = Number(row["Total Quantity"]);
    const addQty = Number(row["Add to Quantity"]);
    if ((isNaN(totalQty) || totalQty < 1) && (isNaN(addQty) || addQty < 1)) {
      continue;
    }
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
      updatedRows.push(row);
      continue;
    }

    try {
      const latestSalesResult = await getSuggestedPriceFromLatestSales(sku);
      if (latestSalesResult.suggestedPrice) {
        row["TCG Marketplace Price"] = Number(
          latestSalesResult.suggestedPrice
        ).toFixed(2);
      } else {
        row["Error"] = "No suggested price from latest sales";
      }
      console.log(
        `Row ${i + 1}: SKU ${skuId} priced at ${
          row["TCG Marketplace Price"]
        } (Latest Sales: ${row["TCG Latest Sales Price"]})`
      );
      updatedRows.push(row);
    } catch (err: any) {
      row["Error"] = `Error getting suggested price: ${err?.message || err}`;
      updatedRows.push(row);
      continue;
    }
  }
  console.log("All rows processed, generating CSV");
  const csv = Papa.unparse(updatedRows);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename=priced-listings-${Date.now}.csv`,
    },
  });
}

export default function PricerRoute() {
  const { Form, state, data } = useFetcher();
  const processing = state === "submitting";

  useEffect(() => {
    if (
      data &&
      typeof data === "string" &&
      (data.startsWith("\uFEFF")
        ? data.slice(1, 20).includes(",")
        : data.includes(","))
    ) {
      // Heuristic: if data is a CSV string, trigger download
      const blob = new Blob([data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "priced-listings.csv";
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
    </Box>
  );
}
