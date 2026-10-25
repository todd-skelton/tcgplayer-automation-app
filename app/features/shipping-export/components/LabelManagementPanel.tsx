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
  EasyPostEnvironmentStatus,
  EasyPostService,
  EasyPostShipment,
  LabelPurchaseType,
  ShippingExportConfig,
  ShippingPostageDirection,
  ShippingPostagePurchaseEntry,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";
import { getLabelDirections } from "../services/shippingExportUtils";
import { ShipmentAddressFields, ShipmentPackageFields } from "./ShipmentFields";

interface LabelManagementPanelProps {
  config: ShippingExportConfig;
  environmentStatus: EasyPostEnvironmentStatus;
  sellerKeyInput: string;
  orderNumberInput: string;
  order: TcgPlayerShippingOrder | null;
  /** The order's shipment as edited here; outbound as shown, return with the addresses swapped. */
  shipment: EasyPostShipment | null;
  purchaseType: LabelPurchaseType;
  outboundEntry: ShippingPostagePurchaseEntry | null;
  returnEntry: ShippingPostagePurchaseEntry | null;
  isLoadingOrder: boolean;
  isLoadingLabels: boolean;
  isPurchasing: boolean;
  onOrderNumberChange: (value: string) => void;
  onLookupOrder: () => void;
  onPurchaseTypeChange: (type: LabelPurchaseType) => void;
  onShipmentChange: (changes: Partial<EasyPostShipment>) => void;
  onServiceChange: (service: EasyPostService) => void;
  onResetShipment: () => void;
  onBuyLabels: () => void;
}

const PURCHASE_TYPE_LABELS: Record<LabelPurchaseType, string> = {
  "outbound-only": "Outbound Label",
  "round-trip": "Outbound + Return Labels",
  "return-only": "Return Label",
};

const DIRECTION_NAMES: Record<ShippingPostageDirection, string> = {
  outbound: "An outbound label",
  return: "A return label",
};

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

function describeRepurchase(directions: ShippingPostageDirection[]): string {
  const purchased =
    directions.length > 1
      ? "Outbound and return labels were already purchased for this order. Buying again charges for new labels."
      : `${DIRECTION_NAMES[directions[0]]} was already purchased for this order. Buying again charges for a new label.`;
  const replacement = directions.includes("outbound")
    ? " The new outbound label becomes the order's label; refund the old one in EasyPost if it will not be used."
    : "";

  return `${purchased}${replacement}`;
}

export function LabelManagementPanel({
  config,
  environmentStatus,
  sellerKeyInput,
  orderNumberInput,
  order,
  shipment,
  purchaseType,
  outboundEntry,
  returnEntry,
  isLoadingOrder,
  isLoadingLabels,
  isPurchasing,
  onOrderNumberChange,
  onLookupOrder,
  onPurchaseTypeChange,
  onShipmentChange,
  onServiceChange,
  onResetShipment,
  onBuyLabels,
}: LabelManagementPanelProps) {
  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;
  const entriesByDirection: Record<ShippingPostageDirection, ShippingPostagePurchaseEntry | null> = {
    outbound: outboundEntry,
    return: returnEntry,
  };
  const hasAnyLabelEntry = Boolean(outboundEntry || returnEntry);
  const repurchasedDirections = getLabelDirections(purchaseType).filter((direction) =>
    isPurchased(entriesByDirection[direction]),
  );
  const buyButtonLabel = isPurchasing
    ? "Buying Labels..."
    : `${repurchasedDirections.length > 0 ? "Buy Another" : "Buy"} ${PURCHASE_TYPE_LABELS[purchaseType]}`;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body2" color="text.secondary">
          Seller key: <strong>{sellerKeyInput || "(not set)"}</strong>. Set the seller key on Load Orders.
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
          value={orderNumberInput}
          onChange={(event) => onOrderNumberChange(event.target.value)}
          placeholder="Enter order number"
          sx={{ minWidth: { xs: "100%", md: 320 } }}
        />
        <Button
          variant="contained"
          color="secondary"
          onClick={onLookupOrder}
          disabled={isLoadingOrder || !orderNumberInput.trim()}
          startIcon={isLoadingOrder ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {isLoadingOrder ? "Looking Up Order..." : "Lookup Order"}
        </Button>
      </Stack>

      {order && (
        <>
          <Divider />

          <Box>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              Order {order["Order #"]}
            </Typography>
            <Stack direction="row" spacing={2}>
              <Chip label={`${order["Item Count"]} items`} size="small" variant="outlined" />
              <Chip label={`$${order["Value Of Products"].toFixed(2)}`} size="small" variant="outlined" />
              <Chip label={order["Shipping Method"]} size="small" variant="outlined" />
            </Stack>
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Purchased Labels
            </Typography>
            {isLoadingLabels ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">
                  Checking for previously purchased labels...
                </Typography>
              </Stack>
            ) : hasAnyLabelEntry ? (
              <Stack spacing={2}>
                {outboundEntry && (
                  <PurchasedLabelSummary title="Outbound (seller → buyer)" entry={outboundEntry} />
                )}
                {returnEntry && (
                  <PurchasedLabelSummary title="Return (buyer → seller)" entry={returnEntry} />
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
            <FormLabel>Labels to Buy</FormLabel>
            <RadioGroup
              value={purchaseType}
              onChange={(_, value) => onPurchaseTypeChange(value as LabelPurchaseType)}
            >
              <FormControlLabel
                value="outbound-only"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body2" fontWeight={600}>Outbound only</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Buy only an outbound label (seller → buyer). Use to replace a label, such as after correcting the address.
                    </Typography>
                  </Box>
                }
              />
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

          {shipment && (
            <Stack spacing={2}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="subtitle2">Buyer Address</Typography>
                <Button size="small" onClick={onResetShipment}>
                  Reset to Order
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Starts from the TCGplayer order. Changes apply only to labels bought here; the order itself is not updated.
              </Typography>
              <ShipmentAddressFields
                address={shipment.to_address}
                onChange={(to_address) => onShipmentChange({ to_address })}
              />
              <Typography variant="subtitle2">Package</Typography>
              <ShipmentPackageFields
                shipment={shipment}
                onChange={onShipmentChange}
                onServiceChange={onServiceChange}
              />
              <Typography variant="caption" color="text.secondary">
                Return labels use the same package with the addresses swapped.
              </Typography>
            </Stack>
          )}

          {!selectedModeHasApiKey && (
            <Alert severity="warning">
              {config.easypostMode === "test"
                ? "EASYPOST_TEST_API_KEY is not set."
                : "EASYPOST_PRODUCTION_API_KEY is not set."}{" "}
              Postage purchase is disabled.
            </Alert>
          )}

          {repurchasedDirections.length > 0 && !isLoadingLabels && (
            <Alert severity="warning">{describeRepurchase(repurchasedDirections)}</Alert>
          )}

          <Box>
            <Button
              variant="contained"
              color={config.easypostMode === "test" ? "warning" : "primary"}
              onClick={onBuyLabels}
              disabled={
                !selectedModeHasApiKey ||
                isPurchasing ||
                isLoadingLabels ||
                !shipment
              }
              startIcon={isPurchasing ? <CircularProgress color="inherit" size={18} /> : undefined}
            >
              {buyButtonLabel}
            </Button>
          </Box>
        </>
      )}
    </Stack>
  );
}
