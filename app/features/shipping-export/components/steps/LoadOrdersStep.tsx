import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { ShippingExportConfig, TcgPlayerShippingOrder } from "../../types/shippingExport";

interface LoadOrdersStepProps {
  config: ShippingExportConfig;
  sellerKeyInput: string;
  singleOrderNumberInput: string;
  sourceOrders: TcgPlayerShippingOrder[];
  loadedSourceLabel: string;
  isLoadingLiveOrders: boolean;
  isLoadingSingleOrder: boolean;
  isLoadingExistingPostage: boolean;
  loadWarnings: string[];
  onSellerKeyChange: (value: string) => void;
  onSingleOrderNumberChange: (value: string) => void;
  onLoadLiveOrders: () => void;
  onLoadSingleOrder: () => void;
  onContinue: () => void;
}

export function LoadOrdersStep({
  config,
  sellerKeyInput,
  singleOrderNumberInput,
  sourceOrders,
  loadedSourceLabel,
  isLoadingLiveOrders,
  isLoadingSingleOrder,
  isLoadingExistingPostage,
  loadWarnings,
  onSellerKeyChange,
  onSingleOrderNumberChange,
  onLoadLiveOrders,
  onLoadSingleOrder,
  onContinue,
}: LoadOrdersStepProps) {
  return (
    <Stack spacing={3}>
      {loadWarnings.length > 0 && (
        <Alert severity="warning">
          <Stack spacing={0.5}>
            <Typography variant="body2" fontWeight={600}>
              Order load warnings
            </Typography>
            {loadWarnings.map((warning) => (
              <Typography key={warning} variant="body2">
                {warning}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Live TCGPlayer Seller Orders
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Load live Ready to Ship orders directly from TCGPlayer using your
          saved seller key or an override entered here.
        </Typography>
      </Box>

      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        alignItems={{ md: "center" }}
        flexWrap="wrap"
      >
        <TextField
          label="Seller Key"
          value={sellerKeyInput}
          onChange={(event) => onSellerKeyChange(event.target.value)}
          placeholder={config.defaultSellerKey || "Enter seller key"}
          helperText={
            config.defaultSellerKey
              ? `Saved default: ${config.defaultSellerKey}`
              : "Save a default seller key in Shipping Configuration or enter one here."
          }
          sx={{ minWidth: { xs: "100%", md: 320 } }}
        />
        <Button
          variant="contained"
          onClick={onLoadLiveOrders}
          disabled={isLoadingLiveOrders || isLoadingSingleOrder}
          startIcon={
            isLoadingLiveOrders ? (
              <CircularProgress color="inherit" size={18} />
            ) : undefined
          }
        >
          {isLoadingLiveOrders ? "Loading Live Orders..." : "Load Live TCGPlayer Orders"}
        </Button>
      </Stack>

      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Single Order Lookup
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Load one TCGPlayer order by number when you want to inspect it and buy
          postage without pulling the full live queue. The seller key above is
          used for the lookup.
        </Typography>
      </Box>

      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        alignItems={{ md: "center" }}
        flexWrap="wrap"
      >
        <TextField
          label="Order Number"
          value={singleOrderNumberInput}
          onChange={(event) => onSingleOrderNumberChange(event.target.value)}
          placeholder="Enter order number"
          sx={{ minWidth: { xs: "100%", md: 320 } }}
        />
        <Button
          variant="contained"
          color="secondary"
          onClick={onLoadSingleOrder}
          disabled={isLoadingSingleOrder || isLoadingLiveOrders}
          startIcon={
            isLoadingSingleOrder ? (
              <CircularProgress color="inherit" size={18} />
            ) : undefined
          }
        >
          {isLoadingSingleOrder ? "Looking Up Order..." : "Lookup Single Order"}
        </Button>
      </Stack>

      {(loadedSourceLabel || isLoadingExistingPostage) && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          {loadedSourceLabel && (
            <Chip
              label={loadedSourceLabel}
              size="small"
              color="primary"
              variant="outlined"
            />
          )}
          <Chip
            label={`${sourceOrders.length} orders loaded`}
            size="small"
            variant="outlined"
          />
          {isLoadingExistingPostage && (
            <Chip
              label="Loading saved labels..."
              size="small"
              color="info"
              variant="outlined"
            />
          )}
        </Stack>
      )}

      <Box>
        <Button
          variant="contained"
          size="large"
          disabled={sourceOrders.length === 0 || isLoadingLiveOrders || isLoadingSingleOrder || isLoadingExistingPostage}
          onClick={onContinue}
        >
          Continue to Pull Sheet
        </Button>
      </Box>
    </Stack>
  );
}
