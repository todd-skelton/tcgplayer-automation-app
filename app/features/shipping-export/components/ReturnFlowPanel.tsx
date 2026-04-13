import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  EasyPostMode,
  EasyPostShipment,
  ReturnFlowType,
  ShippingExportConfig,
  ShippingPostagePurchaseResult,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";
import type { EasyPostEnvironmentStatus } from "../types/shippingExport";

type PurchaseEntry = {
  mode: EasyPostMode;
  result: ShippingPostagePurchaseResult;
};

interface ReturnFlowPanelProps {
  config: ShippingExportConfig;
  environmentStatus: EasyPostEnvironmentStatus;
  sellerKeyInput: string;
  singleOrderNumberInput: string;
  returnOrder: TcgPlayerShippingOrder | null;
  returnShipment: EasyPostShipment | null;
  returnFlowType: ReturnFlowType;
  outboundReturnPurchaseEntry: PurchaseEntry | null;
  returnOnlyPurchaseEntry: PurchaseEntry | null;
  isLoadingReturnOrder: boolean;
  isPurchasingReturn: boolean;
  onOrderNumberChange: (value: string) => void;
  onLookupOrder: () => void;
  onReturnFlowTypeChange: (type: ReturnFlowType) => void;
  onBuyLabels: () => void;
}

export function ReturnFlowPanel({
  config,
  environmentStatus,
  sellerKeyInput,
  singleOrderNumberInput,
  returnOrder,
  returnShipment,
  returnFlowType,
  outboundReturnPurchaseEntry,
  returnOnlyPurchaseEntry,
  isLoadingReturnOrder,
  isPurchasingReturn,
  onOrderNumberChange,
  onLookupOrder,
  onReturnFlowTypeChange,
  onBuyLabels,
}: ReturnFlowPanelProps) {
  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body2" color="text.secondary">
          Seller key: <strong>{sellerKeyInput || "(not set)"}</strong>. Set the seller key in the Outbound Workflow tab.
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
          onChange={(event) => onOrderNumberChange(event.target.value)}
          placeholder="Enter order number"
          sx={{ minWidth: { xs: "100%", md: 320 } }}
        />
        <Button
          variant="contained"
          color="secondary"
          onClick={onLookupOrder}
          disabled={isLoadingReturnOrder || !singleOrderNumberInput.trim()}
          startIcon={isLoadingReturnOrder ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {isLoadingReturnOrder ? "Looking Up Order..." : "Lookup Order"}
        </Button>
      </Stack>

      {returnOrder && (
        <>
          <Divider />

          <Box>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              Order {returnOrder["Order #"]}
            </Typography>
            <Stack spacing={0.5}>
              <Typography variant="body2">
                {returnOrder.FirstName} {returnOrder.LastName}
              </Typography>
              <Typography variant="body2" component="pre" sx={{ fontFamily: "inherit" }}>
                {[
                  returnOrder.Address1,
                  returnOrder.Address2,
                  `${returnOrder.City}, ${returnOrder.State} ${returnOrder.PostalCode}`,
                  returnOrder.Country,
                ].filter(Boolean).join("\n")}
              </Typography>
              <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
                <Chip label={`${returnOrder["Item Count"]} items`} size="small" variant="outlined" />
                <Chip label={`$${returnOrder["Value Of Products"].toFixed(2)}`} size="small" variant="outlined" />
                <Chip label={returnOrder["Shipping Method"]} size="small" variant="outlined" />
              </Stack>
            </Stack>
          </Box>

          <FormControl>
            <FormLabel>Return Postage Type</FormLabel>
            <RadioGroup
              value={returnFlowType}
              onChange={(_, value) => onReturnFlowTypeChange(value as ReturnFlowType)}
            >
              <FormControlLabel
                value="round-trip"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body2" fontWeight={600}>Round-trip</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Buy outbound (seller → buyer) + return label (buyer → seller). Use when mailing a physical envelope or replacement.
                    </Typography>
                  </Box>
                }
              />
              <FormControlLabel
                value="return-only"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body2" fontWeight={600}>Return only</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Buy only a return label (buyer → seller) to send digitally or include in a package.
                    </Typography>
                  </Box>
                }
              />
            </RadioGroup>
          </FormControl>

          {!selectedModeHasApiKey && (
            <Alert severity="warning">
              {config.easypostMode === "test"
                ? "EASYPOST_TEST_API_KEY is not set."
                : "EASYPOST_PRODUCTION_API_KEY is not set."}{" "}
              Postage purchase is disabled.
            </Alert>
          )}

          <Box>
            <Button
              variant="contained"
              color={config.easypostMode === "test" ? "warning" : "primary"}
              onClick={onBuyLabels}
              disabled={!selectedModeHasApiKey || isPurchasingReturn || !returnShipment}
              startIcon={isPurchasingReturn ? <CircularProgress color="inherit" size={18} /> : undefined}
            >
              {isPurchasingReturn
                ? "Buying Labels..."
                : returnFlowType === "round-trip"
                  ? "Buy Outbound + Return Labels"
                  : "Buy Return Label"}
            </Button>
          </Box>

          {(outboundReturnPurchaseEntry || returnOnlyPurchaseEntry) && (
            <>
              <Divider />
              <Typography variant="subtitle2">Purchased Labels</Typography>

              {outboundReturnPurchaseEntry && (
                <Box>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Outbound (seller → buyer)
                  </Typography>
                  <Stack spacing={1} alignItems="flex-start">
                    <Chip
                      label={outboundReturnPurchaseEntry.result.status.toUpperCase()}
                      size="small"
                      color={
                        outboundReturnPurchaseEntry.result.status === "purchased"
                          ? "success"
                          : outboundReturnPurchaseEntry.result.status === "failed"
                            ? "error"
                            : "warning"
                      }
                    />
                    {outboundReturnPurchaseEntry.result.trackingCode && (
                      <Typography variant="body2">
                        Tracking: {outboundReturnPurchaseEntry.result.trackingCode}
                      </Typography>
                    )}
                    {outboundReturnPurchaseEntry.result.labelPdfUrl && (
                      <Button
                        component="a"
                        href={outboundReturnPurchaseEntry.result.labelPdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="outlined"
                        size="small"
                      >
                        Open Outbound Label PDF
                      </Button>
                    )}
                    {outboundReturnPurchaseEntry.result.error && (
                      <Typography variant="body2" color="error">
                        {outboundReturnPurchaseEntry.result.error}
                      </Typography>
                    )}
                  </Stack>
                </Box>
              )}

              {returnOnlyPurchaseEntry && (
                <Box>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Return (buyer → seller)
                  </Typography>
                  <Stack spacing={1} alignItems="flex-start">
                    <Chip
                      label={returnOnlyPurchaseEntry.result.status.toUpperCase()}
                      size="small"
                      color={
                        returnOnlyPurchaseEntry.result.status === "purchased"
                          ? "success"
                          : returnOnlyPurchaseEntry.result.status === "failed"
                            ? "error"
                            : "warning"
                      }
                    />
                    {returnOnlyPurchaseEntry.result.trackingCode && (
                      <Typography variant="body2">
                        Tracking: {returnOnlyPurchaseEntry.result.trackingCode}
                      </Typography>
                    )}
                    {returnOnlyPurchaseEntry.result.labelPdfUrl && (
                      <Button
                        component="a"
                        href={returnOnlyPurchaseEntry.result.labelPdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="outlined"
                        size="small"
                      >
                        Open Return Label PDF
                      </Button>
                    )}
                    {!returnOnlyPurchaseEntry.result.labelPdfUrl && returnOnlyPurchaseEntry.result.labelUrl && (
                      <Button
                        component="a"
                        href={returnOnlyPurchaseEntry.result.labelUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="outlined"
                        size="small"
                      >
                        Open Return Label
                      </Button>
                    )}
                    {returnOnlyPurchaseEntry.result.error && (
                      <Typography variant="body2" color="error">
                        {returnOnlyPurchaseEntry.result.error}
                      </Typography>
                    )}
                  </Stack>
                </Box>
              )}
            </>
          )}
        </>
      )}
    </Stack>
  );
}
