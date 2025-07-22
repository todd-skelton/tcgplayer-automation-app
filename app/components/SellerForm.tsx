import React, { useState, useEffect } from "react";
import { Box, TextField, Button, Stack, Typography } from "@mui/material";
import { useConfiguration } from "../hooks/useConfiguration";

interface SellerFormProps {
  onSubmit: (sellerKey: string, percentile: number) => Promise<void>;
  isProcessing: boolean;
  onCancel: () => void;
}

export function SellerForm({
  onSubmit,
  isProcessing,
  onCancel,
}: SellerFormProps) {
  const { config, updateFormDefaults } = useConfiguration();

  const [sellerKey, setSellerKey] = useState(config.formDefaults.sellerKey);
  const [percentile, setPercentile] = useState<number>(
    config.formDefaults.percentile
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Update form state when config changes (after localStorage loads)
  useEffect(() => {
    setSellerKey(config.formDefaults.sellerKey);
    setPercentile(config.formDefaults.percentile);
  }, [config.formDefaults.sellerKey, config.formDefaults.percentile]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!sellerKey.trim()) {
      return;
    }

    // Validate percentile range
    if (
      percentile < config.pricing.minPercentile ||
      percentile > config.pricing.maxPercentile
    ) {
      return;
    }

    // Save form defaults for next time
    updateFormDefaults({ sellerKey: sellerKey.trim(), percentile });

    setIsSubmitting(true);
    try {
      await onSubmit(sellerKey.trim(), percentile);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    onCancel();
    setSellerKey("");
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      <Stack spacing={3}>
        <Typography variant="body2" color="text.secondary">
          Enter a seller key to fetch and price all their current inventory.
          This will retrieve all active listings for the seller and run the
          pricing algorithm on each item.
        </Typography>

        <TextField
          label="Seller Key"
          value={sellerKey}
          onChange={(e) => setSellerKey(e.target.value)}
          placeholder="Enter seller key (e.g., 'seller123')"
          fullWidth
          required
          disabled={isProcessing}
          helperText="The unique identifier for the seller whose inventory you want to price"
        />

        <TextField
          label="Percentile"
          type="number"
          value={percentile}
          onChange={(e) => setPercentile(Number(e.target.value))}
          placeholder="Enter percentile (0-100)"
          fullWidth
          disabled={isProcessing}
          inputProps={{
            min: config.pricing.minPercentile,
            max: config.pricing.maxPercentile,
          }}
          helperText={`Percentile for suggested price calculation (${config.pricing.minPercentile}-${config.pricing.maxPercentile}). Examples: 65, 75, 80`}
        />

        <Box sx={{ display: "flex", gap: 2 }}>
          {!isProcessing ? (
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={
                !sellerKey.trim() ||
                isSubmitting ||
                percentile < config.pricing.minPercentile ||
                percentile > config.pricing.maxPercentile
              }
            >
              {isSubmitting ? "Starting..." : "Process Seller Inventory"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outlined"
              color="error"
              fullWidth
              onClick={handleCancel}
            >
              Cancel Processing
            </Button>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
