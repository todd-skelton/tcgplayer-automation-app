import React, { useState } from "react";
import { Box, TextField, Button, Stack, Typography } from "@mui/material";
import { PRICING_CONSTANTS } from "../constants/pricing";

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
  const [sellerKey, setSellerKey] = useState("");
  const [percentile, setPercentile] = useState<number>(
    PRICING_CONSTANTS.DEFAULT_PERCENTILE
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!sellerKey.trim()) {
      return;
    }

    // Validate percentile range
    if (
      percentile < PRICING_CONSTANTS.MIN_PERCENTILE ||
      percentile > PRICING_CONSTANTS.MAX_PERCENTILE
    ) {
      return;
    }

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
            min: PRICING_CONSTANTS.MIN_PERCENTILE,
            max: PRICING_CONSTANTS.MAX_PERCENTILE,
          }}
          helperText={`Percentile for suggested price calculation (${PRICING_CONSTANTS.MIN_PERCENTILE}-${PRICING_CONSTANTS.MAX_PERCENTILE}). Examples: 65, 75, 80`}
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
                percentile < PRICING_CONSTANTS.MIN_PERCENTILE ||
                percentile > PRICING_CONSTANTS.MAX_PERCENTILE
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
