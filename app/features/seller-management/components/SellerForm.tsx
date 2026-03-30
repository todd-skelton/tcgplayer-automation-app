import React, { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { Link, useFetcher } from "react-router";
import { useConfiguration } from "../../pricing/hooks/useConfiguration";
import type { ProductLine } from "~/shared/data-types/productLine";

interface SellerFormProps {
  onSubmit: (sellerKey: string) => Promise<void>;
  isProcessing: boolean;
}

export function SellerForm({ onSubmit, isProcessing }: SellerFormProps) {
  const { config, updateFormDefaults } = useConfiguration();

  const [sellerKey, setSellerKey] = useState(config.formDefaults.sellerKey);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const productLinesFetcher = useFetcher<ProductLine[]>();

  useEffect(() => {
    if (productLinesFetcher.state === "idle" && !productLinesFetcher.data) {
      productLinesFetcher.load("/api/inventory/product-lines");
    }
  }, [productLinesFetcher]);

  const productLines = productLinesFetcher.data || [];

  const getProductLineName = (productLineId: number): string => {
    const productLine = productLines.find(
      (candidate) => candidate.productLineId === productLineId,
    );
    return productLine?.productLineName || `Product Line ${productLineId}`;
  };

  const configuredProductLineIds = Object.keys(
    config.productLinePricing.productLineSettings,
  ).map(Number);

  useEffect(() => {
    setSellerKey(config.formDefaults.sellerKey);
  }, [config.formDefaults.sellerKey]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!sellerKey.trim()) {
      return;
    }

    updateFormDefaults({ sellerKey: sellerKey.trim() });

    setIsSubmitting(true);
    try {
      await onSubmit(sellerKey.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      <Stack spacing={3}>
        <Typography variant="body2" color="text.secondary">
          Enter a seller key to snapshot the seller's live inventory into a batch.
          Background pricing will use the shared server configuration and open in
          the Inventory Batch Pricer when the batch is created.
        </Typography>

        <TextField
          label="Seller Key"
          value={sellerKey}
          onChange={(event) => setSellerKey(event.target.value)}
          placeholder="Enter seller key (e.g., 'seller123')"
          fullWidth
          required
          disabled={isProcessing}
          helperText="The unique identifier for the seller whose inventory you want to price"
        />

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
            <Button component={Link} to="/configuration" size="small" variant="text">
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
                      config.productLinePricing.productLineSettings[productLineId];
                    return (
                      <TableRow key={productLineId}>
                        <TableCell>{getProductLineName(productLineId)}</TableCell>
                        <TableCell align="center">
                          {settings.skip ? "-" : `${settings.percentile}%`}
                        </TableCell>
                        <TableCell align="center">
                          {settings.skip ? (
                            <Chip label="Skipped" size="small" color="warning" />
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

        <Button
          type="submit"
          variant="contained"
          fullWidth
          disabled={!sellerKey.trim() || isProcessing || isSubmitting}
        >
          {isSubmitting || isProcessing ? "Queueing Batch..." : "Queue Seller Batch"}
        </Button>
      </Stack>
    </Box>
  );
}
