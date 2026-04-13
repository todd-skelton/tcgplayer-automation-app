import DownloadIcon from "@mui/icons-material/Download";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type {
  EasyPostMode,
  EasyPostShipment,
  LabelSize,
  ShippingPostageBatchLabelResult,
  ShippingPostagePurchaseResult,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";

type PurchaseEntry = {
  mode: EasyPostMode;
  result: ShippingPostagePurchaseResult;
};

interface PrintStepProps {
  sourceOrders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  outboundPurchaseResultsByReference: Record<string, PurchaseEntry>;
  batchLabelResultsBySize: Partial<Record<LabelSize, ShippingPostageBatchLabelResult>>;
  availableLabelSizes: string[];
  generatingBatchLabelSize: LabelSize | null;
  packingSlipAction: "download" | "open" | null;
  savedPurchasedEntriesForLabelSize: (labelSize: LabelSize) => Array<{
    shipment: EasyPostShipment;
    purchaseEntry: PurchaseEntry;
  }>;
  onOpenPackingSlips: () => void;
  onDownloadPackingSlips: () => void;
  onGenerateBatchLabel: (labelSize: LabelSize) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function PrintStep({
  sourceOrders,
  batchLabelResultsBySize,
  availableLabelSizes,
  generatingBatchLabelSize,
  packingSlipAction,
  savedPurchasedEntriesForLabelSize,
  onOpenPackingSlips,
  onDownloadPackingSlips,
  onGenerateBatchLabel,
  onBack,
  onContinue,
}: PrintStepProps) {
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Packing Slips
        </Typography>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <Button
            variant="outlined"
            startIcon={
              packingSlipAction === "open" ? (
                <CircularProgress color="inherit" size={18} />
              ) : (
                <OpenInNewIcon />
              )
            }
            onClick={onOpenPackingSlips}
            disabled={sourceOrders.length === 0 || packingSlipAction !== null}
          >
            {packingSlipAction === "open" ? "Opening Packing Slips..." : "Open Packing Slips PDF"}
          </Button>
          <Button
            variant="outlined"
            startIcon={
              packingSlipAction === "download" ? (
                <CircularProgress color="inherit" size={18} />
              ) : (
                <DownloadIcon />
              )
            }
            onClick={onDownloadPackingSlips}
            disabled={sourceOrders.length === 0 || packingSlipAction !== null}
          >
            {packingSlipAction === "download" ? "Downloading Packing Slips..." : "Download Packing Slips PDF"}
          </Button>
        </Stack>
      </Box>

      <Divider />

      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Postage Labels
        </Typography>
        {availableLabelSizes.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No postage purchased yet. Go back to Buy Postage to purchase labels.
          </Typography>
        ) : (
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
                      <Button
                        component="a"
                        href={batchLabel.labelUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="contained"
                        startIcon={<OpenInNewIcon />}
                      >
                        Open Batch Label PDF
                      </Button>
                    )}

                    {batchLabel?.status === "ready" && (
                      <Chip
                        label={`${batchLabel.shipmentReferences.length} labels in batch`}
                        color="success"
                        size="small"
                      />
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
                        <Chip
                          label={`${savedEntries.length} saved labels`}
                          color="info"
                          size="small"
                          variant="outlined"
                        />
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

                    {!batchLabel && !canGenerateBatch && (
                      <Typography variant="body2" color="text.secondary">
                        {savedEntries.length > 0
                          ? "Saved labels span multiple EasyPost modes and cannot be combined."
                          : "Buy postage to generate a combined PDF."}
                      </Typography>
                    )}

                    {savedEntries.length > 0 && (
                      <Stack spacing={0.5}>
                        {savedEntries
                          .filter((e) => e.purchaseEntry.result.labelPdfUrl)
                          .map((e) => (
                            <Button
                              key={e.shipment.reference}
                              component="a"
                              href={e.purchaseEntry.result.labelPdfUrl!}
                              target="_blank"
                              rel="noreferrer"
                              size="small"
                              variant="text"
                            >
                              {e.shipment.reference} — Label PDF
                            </Button>
                          ))}
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        <Button variant="contained" onClick={onContinue}>
          Continue to Pack
        </Button>
      </Stack>
    </Stack>
  );
}
