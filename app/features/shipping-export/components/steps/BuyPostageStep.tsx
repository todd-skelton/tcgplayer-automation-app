import { useState } from "react";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  EasyPostEnvironmentStatus,
  EasyPostShipment,
  ShipmentToOrderMap,
  ShippingExportConfig,
  ShippingPostagePurchaseEntry,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";
import { getOrderNumbersForShipmentReference } from "../../services/shippingExportUtils";
import { saleValueOfOrders } from "../../services/saleValue";
import { SaleValueFigures } from "../SaleValueFigures";

interface BuyPostageStepProps {
  config: ShippingExportConfig;
  environmentStatus: EasyPostEnvironmentStatus;
  shipments: EasyPostShipment[];
  /** Orders before address merging, so each shipment's value covers every order in it. */
  sourceOrders: TcgPlayerShippingOrder[];
  shipmentToOrderMap: ShipmentToOrderMap;
  outboundPurchaseResultsByReference: Record<string, ShippingPostagePurchaseEntry>;
  returnPurchaseResultsByReference: Record<string, ShippingPostagePurchaseEntry>;
  /** True while any purchase is running; buying is one at a time. */
  isPurchasing: boolean;
  purchasingActionKey: string | null;
  onBuyShipment: (shipment: EasyPostShipment) => void;
  onBuyReturnLabel: (shipment: EasyPostShipment) => void;
  onEditShipment: (shipment: EasyPostShipment) => void;
  onDownloadShipment: (shipment: EasyPostShipment) => void;
  onDownloadReturnShipment: (shipment: EasyPostShipment) => void;
}

type Purchase = { direction: "outbound" | "return"; shipment: EasyPostShipment };

const STATUS_COLORS = { purchased: "success", failed: "error", skipped: "warning" } as const;

function labelHref(entry: ShippingPostagePurchaseEntry | undefined): string | undefined {
  return entry?.result.labelPdfUrl ?? entry?.result.labelUrl;
}

function isPurchased(entry: ShippingPostagePurchaseEntry | undefined): boolean {
  return entry?.result.status === "purchased";
}

function PostageStatus({ entry }: { entry: ShippingPostagePurchaseEntry | undefined }) {
  if (!entry) {
    return (
      <Typography variant="body2" color="text.secondary">
        Not purchased
      </Typography>
    );
  }

  const { result, mode } = entry;
  const details = [
    `Mode: ${mode}`,
    result.trackingCode && `Tracking: ${result.trackingCode}`,
    result.selectedRate &&
      `Rate: ${result.selectedRate.service} $${result.selectedRate.rate} ${result.selectedRate.currency}`,
  ].filter(Boolean);
  const href = labelHref(entry);

  return (
    <Stack spacing={0.5}>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Tooltip title={details.join(" · ")}>
          <Chip label={result.status.toUpperCase()} color={STATUS_COLORS[result.status]} size="small" />
        </Tooltip>
        {href && (
          <Tooltip title="Open label">
            <IconButton component="a" href={href} target="_blank" rel="noreferrer" size="small" aria-label="Open label">
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {result.error && (
        <Typography variant="caption" color="error">
          {result.error}
        </Typography>
      )}
    </Stack>
  );
}

export function BuyPostageStep({
  config,
  environmentStatus,
  shipments,
  sourceOrders,
  shipmentToOrderMap,
  outboundPurchaseResultsByReference,
  returnPurchaseResultsByReference,
  isPurchasing,
  purchasingActionKey,
  onBuyShipment,
  onBuyReturnLabel,
  onEditShipment,
  onDownloadShipment,
  onDownloadReturnShipment,
}: BuyPostageStepProps) {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; shipment: EasyPostShipment } | null>(null);
  const [confirming, setConfirming] = useState<Purchase | null>(null);
  const selectedModeHasApiKey =
    config.easypostMode === "test" ? environmentStatus.hasTestApiKey : environmentStatus.hasProductionApiKey;
  const canBuy = selectedModeHasApiKey && !isPurchasing;

  /** Buys at once, or asks first when this would buy a second label for the shipment. */
  const requestPurchase = (purchase: Purchase) => {
    const entries =
      purchase.direction === "outbound" ? outboundPurchaseResultsByReference : returnPurchaseResultsByReference;
    const existing = entries[purchase.shipment.reference];
    if (isPurchased(existing) && existing?.mode === config.easypostMode) {
      setConfirming(purchase);
      return;
    }
    (purchase.direction === "outbound" ? onBuyShipment : onBuyReturnLabel)(purchase.shipment);
  };

  const menuReturnEntry = menu ? returnPurchaseResultsByReference[menu.shipment.reference] : undefined;

  return (
    <Stack spacing={2}>
      {!selectedModeHasApiKey && (
        <Alert severity="warning">
          {config.easypostMode === "test" ? "EASYPOST_TEST_API_KEY is not set." : "EASYPOST_PRODUCTION_API_KEY is not set."}{" "}
          Postage purchase is disabled.
        </Alert>
      )}

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Orders</TableCell>
              <TableCell>Recipient</TableCell>
              <TableCell>Parcel and value</TableCell>
              <TableCell>Postage</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shipments.map((shipment) => {
              const orderNumbers = getOrderNumbersForShipmentReference(shipmentToOrderMap, shipment.reference);
              const shipmentOrders = sourceOrders.filter((order) => orderNumbers.includes(order["Order #"]));
              const itemCount = shipmentOrders.reduce((sum, order) => sum + order["Item Count"], 0);
              const purchaseEntry = outboundPurchaseResultsByReference[shipment.reference];
              const isBuyingOutbound = purchasingActionKey === `outbound:${shipment.reference}`;
              const isBuyingReturn = purchasingActionKey === `return:${shipment.reference}`;
              const address = shipment.to_address;
              const fullAddress = [address.name, address.company, address.street1, address.street2,
                `${address.city}, ${address.state} ${address.zip}`, address.country].filter(Boolean).join(", ");

              return (
                <TableRow key={shipment.reference}>
                  <TableCell>
                    {orderNumbers.map((orderNumber) => (
                      <Typography key={orderNumber} variant="body2">
                        {orderNumber}
                      </Typography>
                    ))}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={fullAddress}>
                      <Box>
                        <Typography variant="body2">{address.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {address.city}, {address.state} {address.zip}
                        </Typography>
                      </Box>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                      <Typography variant="body2">
                        {shipment.parcel.predefined_package} · {shipment.parcel.weight}oz · {shipment.service} ·{" "}
                        {shipment.options.label_size} · {itemCount} {itemCount === 1 ? "item" : "items"}
                      </Typography>
                      {shipment.options.delivery_confirmation === "SIGNATURE" && (
                        <Chip label="Sig. Required" size="small" color="warning" />
                      )}
                    </Stack>
                    <SaleValueFigures value={saleValueOfOrders(shipmentOrders)} variant="caption" />
                  </TableCell>
                  <TableCell>
                    <PostageStatus entry={purchaseEntry} />
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
                      <Button
                        size="small"
                        variant={isPurchased(purchaseEntry) ? "outlined" : "contained"}
                        color={config.easypostMode === "test" ? "warning" : "primary"}
                        onClick={() => requestPurchase({ direction: "outbound", shipment })}
                        disabled={!canBuy}
                        startIcon={isBuyingOutbound || isBuyingReturn ? <CircularProgress color="inherit" size={16} /> : undefined}
                      >
                        {isBuyingOutbound
                          ? "Buying..."
                          : isBuyingReturn
                            ? "Buying Return..."
                            : isPurchased(purchaseEntry) && purchaseEntry?.mode === config.easypostMode
                              ? "Buy Again"
                              : "Buy Postage"}
                      </Button>
                      <IconButton
                        aria-label={`More actions for ${shipment.reference}`}
                        aria-haspopup="menu"
                        size="small"
                        onClick={(event) => setMenu({ anchor: event.currentTarget, shipment })}
                      >
                        <MoreVertIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Menu open={Boolean(menu)} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
        {menu && [
          <MenuItem
            key="return"
            disabled={!canBuy}
            onClick={() => {
              setMenu(null);
              requestPurchase({ direction: "return", shipment: menu.shipment });
            }}
          >
            {isPurchased(menuReturnEntry) ? "Buy Another Return Label" : "Buy Return Label"}
          </MenuItem>,
          labelHref(menuReturnEntry) && (
            <MenuItem
              key="open-return"
              component="a"
              href={labelHref(menuReturnEntry)}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenu(null)}
            >
              Open Return Label
            </MenuItem>
          ),
          <MenuItem
            key="edit"
            onClick={() => {
              setMenu(null);
              onEditShipment(menu.shipment);
            }}
          >
            Edit Shipment
          </MenuItem>,
          <MenuItem
            key="csv"
            onClick={() => {
              setMenu(null);
              onDownloadShipment(menu.shipment);
            }}
          >
            Download Shipment CSV
          </MenuItem>,
          <MenuItem
            key="return-csv"
            onClick={() => {
              setMenu(null);
              onDownloadReturnShipment(menu.shipment);
            }}
          >
            Download Return CSV
          </MenuItem>,
        ]}
      </Menu>

      <Dialog open={Boolean(confirming)} onClose={() => setConfirming(null)} aria-labelledby="buy-again-title">
        <DialogTitle id="buy-again-title">
          Buy another {confirming?.direction === "return" ? "return label" : "label"}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirming?.direction === "return" ? "A return label" : "Postage"} was already bought for shipment{" "}
            {confirming?.shipment.reference} in {config.easypostMode} mode. Buying again charges for a new label; the
            first one is not refunded automatically.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              if (confirming) {
                (confirming.direction === "outbound" ? onBuyShipment : onBuyReturnLabel)(confirming.shipment);
              }
              setConfirming(null);
            }}
          >
            Buy Again
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
