import React, { useState, useEffect } from "react";
import {
  Box,
  TextField,
  Button,
  Stack,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Alert,
} from "@mui/material";
import { Link, useFetcher } from "react-router";
import { useConfiguration } from "../../pricing/hooks/useConfiguration";
import type { ProductLine } from "~/shared/data-types/productLine";

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
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch product lines for display names
  const productLinesFetcher = useFetcher<ProductLine[]>();

  useEffect(() => {
    if (productLinesFetcher.state === "idle" && !productLinesFetcher.data) {
      productLinesFetcher.load("/api/inventory/product-lines");
    }
  }, [productLinesFetcher]);

  const productLines = productLinesFetcher.data || [];

  // Get product line name by ID
  const getProductLineName = (productLineId: number): string => {
    const pl = productLines.find((p) => p.productLineId === productLineId);
    return pl?.productLineName || `Product Line ${productLineId}`;
  };

  // Get configured product line IDs
  const configuredProductLineIds = Object.keys(
    config.productLinePricing.productLineSettings,
  ).map(Number);

  // Update form state when config changes (after localStorage loads)
  useEffect(() => {
    setSellerKey(config.formDefaults.sellerKey);
  }, [config.formDefaults.sellerKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!sellerKey.trim()) {
      return;
    }

    // Save form defaults for next time
    updateFormDefaults({ sellerKey: sellerKey.trim() });

    setIsSubmitting(true);
    try {
      // Pass the default percentile - per-product-line config is handled in the pipeline
      await onSubmit(
        sellerKey.trim(),
        config.productLinePricing.defaultPercentile,
      );
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

        {/* Product Line Pricing Summary */}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 1,
            }}
          >
            <Typography variant="subtitle2">Pricing Configuration</Typography>
            <Button
              component={Link}
              to="/configuration"
              size="small"
              variant="text"
            >
              Edit Settings
            </Button>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Default percentile:{" "}
            <Chip
              label={`${config.productLinePricing.defaultPercentile}%`}
              size="small"
              color="primary"
              variant="outlined"
            />
          </Typography>

          {configuredProductLineIds.length > 0 ? (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Product Line</TableCell>
                    <TableCell align="center">Percentile</TableCell>
                    <TableCell align="center">Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {configuredProductLineIds.map((productLineId) => {
                    const settings =
                      config.productLinePricing.productLineSettings[
                        productLineId
                      ];
                    return (
                      <TableRow key={productLineId}>
                        <TableCell>
                          {getProductLineName(productLineId)}
                        </TableCell>
                        <TableCell align="center">
                          {settings.skip ? "—" : `${settings.percentile}%`}
                        </TableCell>
                        <TableCell align="center">
                          {settings.skip ? (
                            <Chip
                              label="Skipped"
                              size="small"
                              color="warning"
                            />
                          ) : (
                            <Chip
                              label="Custom"
                              size="small"
                              color="info"
                              variant="outlined"
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Alert severity="info" sx={{ py: 0.5 }}>
              All product lines will use the default percentile (
              {config.productLinePricing.defaultPercentile}%).
            </Alert>
          )}
        </Paper>

        <Box sx={{ display: "flex", gap: 2 }}>
          {!isProcessing ? (
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={!sellerKey.trim() || isSubmitting}
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
