import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import ReplyIcon from "@mui/icons-material/Reply";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
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
  EasyPostAddress,
  EasyPostMode,
  EasyPostShipment,
  LabelSize,
  ShipmentToOrderMap,
  ShippingExportConfig,
  ShippingPostageBatchLabelResult,
  ShippingPostagePurchaseResult,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";
import type { EasyPostEnvironmentStatus } from "../../types/shippingExport";

type PurchaseEntry = {
  mode: EasyPostMode;
  result: ShippingPostagePurchaseResult;
};

interface BuyPostageStepProps {
  config: ShippingExportConfig;
  environmentStatus: EasyPostEnvironmentStatus;
  shipments: EasyPostShipment[];
  orders: TcgPlayerShippingOrder[];
  shipmentToOrderMap: ShipmentToOrderMap;
  outboundPurchaseResultsByReference: Record<string, PurchaseEntry>;
  returnPurchaseResultsByReference: Record<string, PurchaseEntry>;
  batchLabelResultsBySize: Partial<Record<LabelSize, ShippingPostageBatchLabelResult>>;
  availableLabelSizes: string[];
  purchasingLabelSize: LabelSize | null;
  purchasingActionKey: string | null;
  generatingBatchLabelSize: LabelSize | null;
  isLoadingExistingPostage: boolean;
  onBuyPostage: () => void;
  onBuyShipment: (shipment: EasyPostShipment) => void;
  onBuyReturnLabel: (shipment: EasyPostShipment) => void;
  onGenerateBatchLabel: (labelSize: LabelSize) => void;
  onEditShipment: (shipment: EasyPostShipment) => void;
  onDownloadShipment: (shipment: EasyPostShipment) => void;
  onDownloadReturnShipment: (shipment: EasyPostShipment) => void;
  savedPurchasedEntriesForLabelSize: (labelSize: LabelSize) => Array<{
    shipment: EasyPostShipment;
    purchaseEntry: PurchaseEntry;
  }>;
  onBack: () => void;
  onContinue: () => void;
}

function AddressBlock({ address }: { address: EasyPostAddress }) {
  const lines = [
    address.name,
    address.company,
    address.street1,
    address.street2,
    `${address.city}, ${address.state} ${address.zip}`.trim(),
    address.country,
  ].filter(Boolean);

  return <Typography component="pre" variant="body2">{lines.join("\n")}</Typography>;
}

export function BuyPostageStep({
  config,
  environmentStatus,
  shipments,
  orders,
  shipmentToOrderMap,
  outboundPurchaseResultsByReference,
  returnPurchaseResultsByReference,
  batchLabelResultsBySize,
  availableLabelSizes,
  purchasingLabelSize,
  purchasingActionKey,
  generatingBatchLabelSize,
  isLoadingExistingPostage,
  onBuyPostage,
  onBuyShipment,
  onBuyReturnLabel,
  onGenerateBatchLabel,
  onEditShipment,
  onDownloadShipment,
  onDownloadReturnShipment,
  savedPurchasedEntriesForLabelSize,
  onBack,
  onContinue,
}: BuyPostageStepProps) {
  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;

  const purchasedCount = shipments.filter(
    (s) => outboundPurchaseResultsByReference[s.reference]?.result.status === "purchased",
  ).length;
  const letterCount = shipments.filter((s) => s.parcel.predefined_package === "Letter").length;
  const flatCount = shipments.filter((s) => s.parcel.predefined_package === "Flat").length;
  const parcelCount = shipments.filter((s) => s.parcel.predefined_package === "Parcel").length;

  const allPurchased = shipments.length > 0 && purchasedCount === shipments.length;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ md: "center" }}
      >
        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Chip label={`${shipments.length} shipments`} size="small" />
          {letterCount > 0 && <Chip label={`${letterCount} Letter`} size="small" variant="outlined" />}
          {flatCount > 0 && <Chip label={`${flatCount} Flat`} size="small" variant="outlined" />}
          {parcelCount > 0 && <Chip label={`${parcelCount} Parcel`} size="small" variant="outlined" />}
          {purchasedCount > 0 && (
            <Chip label={`${purchasedCount} postage purchased`} size="small" color="success" variant="outlined" />
          )}
          {purchasedCount < shipments.length && !isLoadingExistingPostage && (
            <Chip label={`${shipments.length - purchasedCount} pending`} size="small" color="warning" variant="outlined" />
          )}
        </Stack>

        <Button
          variant="contained"
          color={config.easypostMode === "test" ? "warning" : "primary"}
          onClick={onBuyPostage}
          disabled={
            availableLabelSizes.length === 0 ||
            !selectedModeHasApiKey ||
            purchasingLabelSize !== null ||
            purchasingActionKey !== null
          }
          startIcon={purchasingLabelSize ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {purchasingLabelSize ? `Buying ${purchasingLabelSize} Postage...` : "Buy All Postage"}
        </Button>
      </Stack>

      {!selectedModeHasApiKey && (
        <Alert severity="warning">
          {config.easypostMode === "test"
            ? "EASYPOST_TEST_API_KEY is not set."
            : "EASYPOST_PRODUCTION_API_KEY is not set."}{" "}
          Postage purchase is disabled.
        </Alert>
      )}

      <TableContainer>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Orders</TableCell>
              <TableCell>To Address</TableCell>
              <TableCell>Parcel Details</TableCell>
              <TableCell>Service / Label</TableCell>
              <TableCell>Postage</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shipments.map((shipment) => {
              const order = orders.find((o) => o["Order #"] === shipment.reference);
              const purchaseEntry = outboundPurchaseResultsByReference[shipment.reference];
              const returnPurchaseEntry = returnPurchaseResultsByReference[shipment.reference];
              const isBuyingOutbound = purchasingActionKey === `outbound:${shipment.reference}`;
              const isBuyingReturn = purchasingActionKey === `return:${shipment.reference}`;

              return (
                <TableRow key={shipment.reference}>
                  <TableCell>
                    <Stack spacing={0.5}>
                      {(shipmentToOrderMap[shipment.reference] ?? [shipment.reference]).map((num) => (
                        <Typography key={num} variant="body2">{num}</Typography>
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <AddressBlock address={shipment.to_address} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {shipment.parcel.predefined_package} &bull; {shipment.parcel.weight}oz
                      {shipment.options.delivery_confirmation === "SIGNATURE" && (
                        <Chip label="Sig. Required" size="small" color="warning" sx={{ ml: 1 }} />
                      )}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {shipment.parcel.length}&times;{shipment.parcel.width}&times;{shipment.parcel.height} in
                      {order ? ` • ${order["Item Count"]} items • $${order["Value Of Products"]}` : ""}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{shipment.service}</Typography>
                    <Chip label={shipment.options.label_size} size="small" variant="outlined" sx={{ mt: 0.5 }} />
                  </TableCell>
                  <TableCell>
                    {purchaseEntry ? (
                      <Stack spacing={1}>
                        <Chip
                          label={purchaseEntry.result.status.toUpperCase()}
                          color={
                            purchaseEntry.result.status === "purchased"
                              ? "success"
                              : purchaseEntry.result.status === "failed"
                                ? "error"
                                : "warning"
                          }
                          size="small"
                        />
                        <Typography variant="body2" color="text.secondary">
                          Mode: {purchaseEntry.mode}
                        </Typography>
                        {purchaseEntry.result.trackingCode && (
                          <Typography variant="body2">
                            Tracking: {purchaseEntry.result.trackingCode}
                          </Typography>
                        )}
                        {purchaseEntry.result.selectedRate && (
                          <Typography variant="body2">
                            Rate: {purchaseEntry.result.selectedRate.service} $
                            {purchaseEntry.result.selectedRate.rate}{" "}
                            {purchaseEntry.result.selectedRate.currency}
                          </Typography>
                        )}
                        {purchaseEntry.result.labelPdfUrl && (
                          <Button
                            component="a"
                            href={purchaseEntry.result.labelPdfUrl}
                            target="_blank"
                            rel="noreferrer"
                            size="small"
                            variant="outlined"
                          >
                            Open Label PDF
                          </Button>
                        )}
                        {!purchaseEntry.result.labelPdfUrl && purchaseEntry.result.labelUrl && (
                          <Button
                            component="a"
                            href={purchaseEntry.result.labelUrl}
                            target="_blank"
                            rel="noreferrer"
                            size="small"
                            variant="outlined"
                          >
                            Open Label
                          </Button>
                        )}
                        {purchaseEntry.result.error && (
                          <Typography variant="body2" color="error">
                            {purchaseEntry.result.error}
                          </Typography>
                        )}
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Not purchased yet.
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Stack spacing={1} alignItems="flex-start">
                      <Button
                        size="small"
                        variant="contained"
                        color={config.easypostMode === "test" ? "warning" : "primary"}
                        onClick={() => onBuyShipment(shipment)}
                        disabled={
                          !selectedModeHasApiKey ||
                          purchasingLabelSize !== null ||
                          purchasingActionKey !== null
                        }
                        startIcon={isBuyingOutbound ? <CircularProgress color="inherit" size={16} /> : undefined}
                      >
                        {isBuyingOutbound
                          ? "Buying..."
                          : purchaseEntry?.result.status === "purchased" && purchaseEntry.mode === config.easypostMode
                            ? "Buy Again"
                            : "Buy Postage"}
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => onBuyReturnLabel(shipment)}
                        disabled={
                          !selectedModeHasApiKey ||
                          purchasingLabelSize !== null ||
                          purchasingActionKey !== null
                        }
                        startIcon={
                          isBuyingReturn ? (
                            <CircularProgress color="inherit" size={16} />
                          ) : (
                            <ReplyIcon fontSize="small" />
                          )
                        }
                      >
                        {isBuyingReturn ? "Buying..." : "Buy Return Label"}
                      </Button>
                      {returnPurchaseEntry?.result.labelPdfUrl && (
                        <Button
                          component="a"
                          href={returnPurchaseEntry.result.labelPdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          size="small"
                          variant="text"
                        >
                          Open Return PDF
                        </Button>
                      )}
                      {!returnPurchaseEntry?.result.labelPdfUrl && returnPurchaseEntry?.result.labelUrl && (
                        <Button
                          component="a"
                          href={returnPurchaseEntry.result.labelUrl}
                          target="_blank"
                          rel="noreferrer"
                          size="small"
                          variant="text"
                        >
                          Open Return Label
                        </Button>
                      )}
                      <Stack direction="row" spacing={0.5}>
                        <Tooltip title="Edit Shipment" arrow>
                          <IconButton onClick={() => onEditShipment(shipment)} color="primary">
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Download Shipment CSV" arrow>
                          <IconButton onClick={() => onDownloadShipment(shipment)} color="primary">
                            <DownloadIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Download Return CSV" arrow>
                          <IconButton onClick={() => onDownloadReturnShipment(shipment)} color="primary">
                            <ReplyIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {availableLabelSizes.length > 0 && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Batch Labels
          </Typography>
          <Stack direction={{ xs: "column", md: "row" }} spacing={2} flexWrap="wrap">
            {availableLabelSizes.map((labelSize) => {
              const batchLabel = batchLabelResultsBySize[labelSize as LabelSize];
              const savedEntries = savedPurchasedEntriesForLabelSize(labelSize as LabelSize);
              const savedModes = [...new Set(savedEntries.map((e) => e.purchaseEntry.mode))];
              const canGenerateBatch = savedEntries.length > 0 && savedModes.length === 1;

              return (
                <Paper key={labelSize} variant="outlined" sx={{ p: 2, minWidth: 220 }}>
                  <Stack spacing={1.5} alignItems="flex-start">
                    <Typography variant="subtitle2">{labelSize} Labels</Typography>
                    {batchLabel?.status === "ready" && batchLabel.labelUrl && (
                      <Button component="a" href={batchLabel.labelUrl} target="_blank" rel="noreferrer" variant="outlined">
                        Open Batch Label PDF
                      </Button>
                    )}
                    {batchLabel?.status === "ready" && (
                      <Chip label={`Batch PDF Ready (${batchLabel.shipmentReferences.length})`} color="success" size="small" />
                    )}
                    {batchLabel?.status === "pending" && (
                      <Typography variant="body2" color="text.secondary">
                        {batchLabel.message ?? "EasyPost is still generating the batch PDF."}
                      </Typography>
                    )}
                    {batchLabel?.status === "failed" && (
                      <Typography variant="body2" color="error">
                        {batchLabel.message ?? "Failed to generate the batch PDF."}
                      </Typography>
                    )}
                    {!batchLabel && canGenerateBatch && (
                      <>
                        <Chip label={`Saved Labels Ready (${savedEntries.length})`} color="info" size="small" variant="outlined" />
                        <Button
                          variant="outlined"
                          onClick={() => onGenerateBatchLabel(labelSize as LabelSize)}
                          disabled={generatingBatchLabelSize !== null}
                          startIcon={
                            generatingBatchLabelSize === labelSize ? (
                              <CircularProgress color="inherit" size={18} />
                            ) : undefined
                          }
                        >
                          {generatingBatchLabelSize === labelSize
                            ? `Creating ${labelSize} Batch PDF...`
                            : "Create Batch Label PDF"}
                        </Button>
                      </>
                    )}
                    {!batchLabel && !canGenerateBatch && savedEntries.length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        Buy postage to generate a combined PDF.
                      </Typography>
                    )}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        </Box>
      )}

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="contained"
          onClick={onContinue}
          disabled={!allPurchased}
        >
          Continue to Print
        </Button>
        {!allPurchased && shipments.length > 0 && (
          <Button variant="text" onClick={onContinue} size="small" color="inherit">
            Skip (proceed anyway)
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
