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
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  EasyPostService,
  EasyPostShipment,
  ReturnFlowType,
  ShippingExportConfig,
  ShippingPostagePurchaseEntry,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";
import type { EasyPostEnvironmentStatus } from "../types/shippingExport";

interface ReturnFlowPanelProps {
  config: ShippingExportConfig;
  environmentStatus: EasyPostEnvironmentStatus;
  sellerKeyInput: string;
  singleOrderNumberInput: string;
  returnOrder: TcgPlayerShippingOrder | null;
  returnShipment: EasyPostShipment | null;
  returnFlowType: ReturnFlowType;
  returnService: EasyPostService;
  outboundReturnPurchaseEntry: ShippingPostagePurchaseEntry | null;
  returnOnlyPurchaseEntry: ShippingPostagePurchaseEntry | null;
  isLoadingReturnOrder: boolean;
  isLoadingReturnLabels: boolean;
  isPurchasingReturn: boolean;
  onOrderNumberChange: (value: string) => void;
  onLookupOrder: () => void;
  onReturnFlowTypeChange: (type: ReturnFlowType) => void;
  onReturnServiceChange: (service: EasyPostService) => void;
  onBuyLabels: () => void;
}

function isPurchased(entry: ShippingPostagePurchaseEntry | null): boolean {
  return entry?.result.status === "purchased";
}

function formatPurchasedAt(purchasedAt: string | undefined): string | null {
  if (!purchasedAt) {
    return null;
  }

  const date = new Date(purchasedAt);

  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

interface PurchasedLabelSummaryProps {
  title: string;
  entry: ShippingPostagePurchaseEntry;
}

function PurchasedLabelSummary({ title, entry }: PurchasedLabelSummaryProps) {
  const { result, mode } = entry;
  const purchasedAt = formatPurchasedAt(entry.purchasedAt);
  const labelHref = result.labelPdfUrl ?? result.labelUrl;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {title}
      </Typography>
      <Stack spacing={1} alignItems="flex-start">
        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Chip
            label={result.status.toUpperCase()}
            size="small"
            color={
              result.status === "purchased"
                ? "success"
                : result.status === "failed"
                  ? "error"
                  : "warning"
            }
          />
          <Chip label={mode === "test" ? "TEST" : "PRODUCTION"} size="small" variant="outlined" />
          {result.selectedRate && (
            <Chip
              label={`${result.selectedRate.service} ${result.selectedRate.rate} ${result.selectedRate.currency}`}
              size="small"
              variant="outlined"
            />
          )}
        </Stack>
        {purchasedAt && (
          <Typography variant="caption" color="text.secondary">
            Purchased {purchasedAt}
          </Typography>
        )}
        {result.trackingCode && (
          <Typography variant="body2">Tracking: {result.trackingCode}</Typography>
        )}
        {labelHref && (
          <Button
            component="a"
            href={labelHref}
            target="_blank"
            rel="noreferrer"
            variant="outlined"
            size="small"
          >
            {result.labelPdfUrl ? "Open Label PDF" : "Open Label"}
          </Button>
        )}
        {result.error && (
          <Typography variant="body2" color="error">
            {result.error}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

export function ReturnFlowPanel({
  config,
  environmentStatus,
  sellerKeyInput,
  singleOrderNumberInput,
  returnOrder,
  returnShipment,
  returnFlowType,
  returnService,
  outboundReturnPurchaseEntry,
  returnOnlyPurchaseEntry,
  isLoadingReturnOrder,
  isLoadingReturnLabels,
  isPurchasingReturn,
  onOrderNumberChange,
  onLookupOrder,
  onReturnFlowTypeChange,
  onReturnServiceChange,
  onBuyLabels,
}: ReturnFlowPanelProps) {
  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;
  const hasOutboundLabel = isPurchased(outboundReturnPurchaseEntry);
  const hasReturnLabel = isPurchased(returnOnlyPurchaseEntry);
  const hasAnyLabelEntry = Boolean(outboundReturnPurchaseEntry || returnOnlyPurchaseEntry);
  const wouldRepurchaseOutbound = returnFlowType === "round-trip" && hasOutboundLabel;
  const wouldRepurchaseReturn = hasReturnLabel;
  const buyButtonLabel = isPurchasingReturn
    ? "Buying Labels..."
    : returnFlowType === "round-trip"
      ? wouldRepurchaseOutbound || wouldRepurchaseReturn
        ? "Buy Another Outbound + Return Label"
        : "Buy Outbound + Return Labels"
      : wouldRepurchaseReturn
        ? "Buy Another Return Label"
        : "Buy Return Label";

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

          <Divider />

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Purchased Labels
            </Typography>
            {isLoadingReturnLabels ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">
                  Checking for previously purchased labels...
                </Typography>
              </Stack>
            ) : hasAnyLabelEntry ? (
              <Stack spacing={2}>
                {outboundReturnPurchaseEntry && (
                  <PurchasedLabelSummary
                    title="Outbound (seller → buyer)"
                    entry={outboundReturnPurchaseEntry}
                  />
                )}
                {returnOnlyPurchaseEntry && (
                  <PurchasedLabelSummary
                    title="Return (buyer → seller)"
                    entry={returnOnlyPurchaseEntry}
                  />
                )}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                No labels have been purchased for this order yet.
              </Typography>
            )}
          </Box>

          <Divider />

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

          <FormControl sx={{ maxWidth: 320 }}>
            <InputLabel id="return-service-label">Postage Service</InputLabel>
            <Select
              labelId="return-service-label"
              label="Postage Service"
              value={returnService}
              onChange={(event) =>
                onReturnServiceChange(event.target.value as EasyPostService)
              }
            >
              <MenuItem value="First">First</MenuItem>
              <MenuItem value="GroundAdvantage">Ground Advantage</MenuItem>
              <MenuItem value="Priority">Priority</MenuItem>
              <MenuItem value="Express">Express</MenuItem>
            </Select>
          </FormControl>

          {!selectedModeHasApiKey && (
            <Alert severity="warning">
              {config.easypostMode === "test"
                ? "EASYPOST_TEST_API_KEY is not set."
                : "EASYPOST_PRODUCTION_API_KEY is not set."}{" "}
              Postage purchase is disabled.
            </Alert>
          )}

          {(wouldRepurchaseOutbound || wouldRepurchaseReturn) && !isLoadingReturnLabels && (
            <Alert severity="warning">
              {wouldRepurchaseOutbound && wouldRepurchaseReturn
                ? "Outbound and return labels were already purchased for this order. Buying again will charge for new labels."
                : wouldRepurchaseOutbound
                  ? "An outbound label was already purchased for this order. Choose Return only to avoid buying another outbound label."
                  : "A return label was already purchased for this order. Buying again will charge for a new label."}
            </Alert>
          )}

          <Box>
            <Button
              variant="contained"
              color={config.easypostMode === "test" ? "warning" : "primary"}
              onClick={onBuyLabels}
              disabled={
                !selectedModeHasApiKey ||
                isPurchasingReturn ||
                isLoadingReturnLabels ||
                !returnShipment
              }
              startIcon={isPurchasingReturn ? <CircularProgress color="inherit" size={18} /> : undefined}
            >
              {buyButtonLabel}
            </Button>
          </Box>
        </>
      )}
    </Stack>
  );
}
