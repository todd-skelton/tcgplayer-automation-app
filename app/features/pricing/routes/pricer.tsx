import React, { useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Box, Paper, Typography } from "@mui/material";
import { UploadForm } from "../../file-upload/components";
import { QuickSettings } from "../components";
import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";

export default function PricerRoute() {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (file: File) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/inventory-batches/import-csv", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as InventoryBatch | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Failed to queue CSV pricing batch",
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
        TCGPlayer CSV Pricer
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            mb: 3,
          }}
        >
          <Box>
            <Typography variant="h6">Queue CSV Pricing Batch</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Upload a CSV export to freeze it into a batch, queue background
              pricing on the server, and review progress from the Inventory Batch
              Pricer.
            </Typography>
          </Box>
          <QuickSettings compact />
        </Box>
        <UploadForm onSubmit={handleSubmit} isProcessing={isSubmitting} />
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography>{error}</Typography>
        </Alert>
      )}
    </Box>
  );
}
