import React, { useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Box, Paper, Typography } from "@mui/material";
import { SellerForm } from "../components";
import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";

export default function SellerInventoryPricerRoute() {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (sellerKey: string) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/inventory-batches/import-seller", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerKey }),
      });
      const payload = (await response.json()) as InventoryBatch | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Failed to queue seller inventory batch",
        );
      }

      const batch = payload as InventoryBatch;
      navigate(`/pending-inventory-pricer?batch=${batch.batchNumber}`);
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Seller Inventory Pricer
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Queue Seller Inventory Batch
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Freeze the seller's current live inventory into a batch, queue background
          pricing on the server, then review progress and downloads from the
          Inventory Batch Pricer.
        </Typography>
        <SellerForm onSubmit={handleSubmit} isProcessing={isSubmitting} />
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography>{error}</Typography>
        </Alert>
      )}
    </Box>
  );
}
