import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ReplyIcon from "@mui/icons-material/Reply";
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  CircularProgress,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { data, Link, type MetaFunction, useLoaderData } from "react-router";
import Papa from "papaparse";
import { useState } from "react";
import { getEasyPostEnvironmentStatus } from "../config/easyPostConfig.server";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import {
  buildTimestampedFileName,
  createReturnShipment,
  getAllLabelSizes,
  getShipmentCsvRows,
  getShipmentsForLabelSize,
  mapOrdersToShipments,
  mergeOrdersByAddress,
  parseShippingOrdersCsv,
} from "../services/shippingExportUtils";
import {
  type EasyPostAddress,
  type EasyPostMode,
  type EasyPostService,
  type EasyPostShipment,
  type LabelFormat,
  type LabelSize,
  type ShippingPostageBatchLabelRequestItem,
  type ShippingPostageBatchLabelResult,
  type ShippingPostageDirection,
  type ShippingPostageLookupResponse,
  type ShippingPostagePurchaseScope,
  type ShippingPostagePurchaseResponse,
  type ShippingPostagePurchaseResult,
  type ShippingLiveOrderLoadResponse,
  type ShippingShippedMessageRequestItem,
  type ShippingShippedMessageResponse,
  type ShippingShippedMessageResult,
  type ShippingTrackingApplyRequestItem,
  type ShippingTrackingApplyResponse,
  type ShippingTrackingApplyResult,
  type ShipmentToOrderMap,
  type ShippingExportConfig,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";

type PurchaseEntry = {
  mode: EasyPostMode;
  result: ShippingPostagePurchaseResult;
};

function buildTrackingApplyItems(
  shipments: EasyPostShipment[],
  shipmentToOrderMap: ShipmentToOrderMap,
  purchaseResultsByReference: Record<string, PurchaseEntry>,
): ShippingTrackingApplyRequestItem[] {
  const seenOrderNumbers = new Set<string>();
  const updates: ShippingTrackingApplyRequestItem[] = [];

  for (const shipment of shipments) {
    const purchaseEntry = purchaseResultsByReference[shipment.reference];

    if (
      !purchaseEntry ||
      purchaseEntry.mode !== "production" ||
      purchaseEntry.result.status !== "purchased" ||
      !purchaseEntry.result.trackingCode
    ) {
      continue;
    }

    for (const orderNumber of shipmentToOrderMap[shipment.reference] ?? [
      shipment.reference,
    ]) {
      const normalizedOrderNumber = orderNumber.trim();

      if (!normalizedOrderNumber || seenOrderNumbers.has(normalizedOrderNumber)) {
        continue;
      }

      seenOrderNumbers.add(normalizedOrderNumber);
      updates.push({
        orderNumber: normalizedOrderNumber,
        carrier: shipment.carrier,
        trackingNumber: purchaseEntry.result.trackingCode,
      });
    }
  }

  return updates;
}

function buildShippedMessageItems(
  shipments: EasyPostShipment[],
  sellerKey: string,
  shipmentToOrderMap: ShipmentToOrderMap,
  purchaseResultsByReference: Record<string, PurchaseEntry>,
): ShippingShippedMessageRequestItem[] {
  const normalizedSellerKey = sellerKey.trim();

  if (!normalizedSellerKey) {
    return [];
  }

  const seenOrderNumbers = new Set<string>();
  const messages: ShippingShippedMessageRequestItem[] = [];

  for (const shipment of shipments) {
    const purchaseEntry = purchaseResultsByReference[shipment.reference];

    if (
      !purchaseEntry ||
      purchaseEntry.mode !== "production" ||
      purchaseEntry.result.status !== "purchased" ||
      !purchaseEntry.result.easypostShipmentId
    ) {
      continue;
    }

    for (const orderNumber of shipmentToOrderMap[shipment.reference] ?? [
      shipment.reference,
    ]) {
      const normalizedOrderNumber = orderNumber.trim();

      if (!normalizedOrderNumber || seenOrderNumbers.has(normalizedOrderNumber)) {
        continue;
      }

      seenOrderNumbers.add(normalizedOrderNumber);
      messages.push({
        orderNumber: normalizedOrderNumber,
        sellerKey: normalizedSellerKey,
        easypostShipmentId: purchaseEntry.result.easypostShipmentId,
      });
    }
  }

  return messages;
}

function updateOrderDerivedState(
  sourceOrders: TcgPlayerShippingOrder[],
  config: ShippingExportConfig,
): {
  orders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  shipmentToOrderMap: ShipmentToOrderMap;
} {
  const mergedOrders = mergeOrdersByAddress(sourceOrders, config.combineOrders);

  return {
    orders: mergedOrders.orders,
    shipments: mapOrdersToShipments(mergedOrders.orders, config),
    shipmentToOrderMap: mergedOrders.shipmentToOrderMap,
  };
}

function downloadCsvFile(
  filenamePrefix: string,
  shipments: EasyPostShipment[],
): void {
  const csvOutput = Papa.unparse(getShipmentCsvRows(shipments));
  const blob = new Blob([csvOutput], { type: "text/csv" });
  downloadBlobFile(blob, buildTimestampedFileName(filenamePrefix));
}

function downloadBlobFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function openBlobInNewTab(blob: Blob, popupWindow?: Window | null): void {
  const url = URL.createObjectURL(blob);

  if (popupWindow) {
    popupWindow.location.href = url;
    popupWindow.focus();
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

function getFileNameFromContentDisposition(
  contentDisposition: string | null,
  fallbackFileName: string,
): string {
  if (!contentDisposition) {
    return fallbackFileName;
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const unquotedMatch = contentDisposition.match(/filename=([^;]+)/i);
  if (unquotedMatch?.[1]) {
    return unquotedMatch[1].trim();
  }

  return fallbackFileName;
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

  return <Typography component="pre">{lines.join("\n")}</Typography>;
}

function ShipmentEditDrawer({
  shipment,
  open,
  onClose,
  onSave,
  onChange,
}: {
  shipment: EasyPostShipment | null;
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  onChange: (changes: Partial<EasyPostShipment>) => void;
}) {
  if (!shipment) {
    return null;
  }

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Container sx={{ width: 420, p: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Edit Shipment</Typography>

          <Typography variant="subtitle2">To Address</Typography>
          <TextField
            label="Name"
            value={shipment.to_address.name}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  name: event.target.value,
                },
              })
            }
          />
          <TextField
            label="Street 1"
            value={shipment.to_address.street1}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  street1: event.target.value,
                },
              })
            }
          />
          <TextField
            label="Street 2"
            value={shipment.to_address.street2 ?? ""}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  street2: event.target.value || undefined,
                },
              })
            }
          />
          <TextField
            label="City"
            value={shipment.to_address.city}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  city: event.target.value,
                },
              })
            }
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="State"
              value={shipment.to_address.state}
              onChange={(event) =>
                onChange({
                  to_address: {
                    ...shipment.to_address,
                    state: event.target.value,
                  },
                })
              }
              fullWidth
            />
            <TextField
              label="Zip"
              value={shipment.to_address.zip}
              onChange={(event) =>
                onChange({
                  to_address: {
                    ...shipment.to_address,
                    zip: event.target.value,
                  },
                })
              }
              fullWidth
            />
          </Stack>

          <Divider />
          <Typography variant="subtitle2">Shipment Details</Typography>
          <TextField
            label="Reference"
            value={shipment.reference}
            onChange={(event) => onChange({ reference: event.target.value })}
          />
          <FormControl fullWidth>
            <InputLabel id="shipment-service-label">Service</InputLabel>
            <Select
              labelId="shipment-service-label"
              label="Service"
              value={shipment.service}
              onChange={(event) =>
                onChange({ service: event.target.value as EasyPostService })
              }
            >
              <MenuItem value="First">First</MenuItem>
              <MenuItem value="GroundAdvantage">Ground Advantage</MenuItem>
              <MenuItem value="Priority">Priority</MenuItem>
              <MenuItem value="Express">Express</MenuItem>
            </Select>
          </FormControl>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Length (in)"
              type="number"
              value={shipment.parcel.length}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    length: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
            <TextField
              label="Width (in)"
              type="number"
              value={shipment.parcel.width}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    width: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Height (in)"
              type="number"
              value={shipment.parcel.height}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    height: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
            <TextField
              label="Weight (oz)"
              type="number"
              value={shipment.parcel.weight}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    weight: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
          </Stack>
          <FormControl fullWidth>
            <InputLabel id="shipment-label-format-label">
              Label Format
            </InputLabel>
            <Select
              labelId="shipment-label-format-label"
              label="Label Format"
              value={shipment.options.label_format}
              onChange={(event) =>
                onChange({
                  options: {
                    ...shipment.options,
                    label_format: event.target.value as LabelFormat,
                  },
                })
              }
            >
              <MenuItem value="PDF">PDF</MenuItem>
              <MenuItem value="PNG">PNG</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth>
            <InputLabel id="shipment-label-size-label">Label Size</InputLabel>
            <Select
              labelId="shipment-label-size-label"
              label="Label Size"
              value={shipment.options.label_size}
              onChange={(event) =>
                onChange({
                  options: {
                    ...shipment.options,
                    label_size: event.target.value as LabelSize,
                  },
                })
              }
            >
              <MenuItem value="4x6">4x6</MenuItem>
              <MenuItem value="7x3">7x3</MenuItem>
              <MenuItem value="6x4">6x4</MenuItem>
            </Select>
          </FormControl>
          <Button variant="contained" onClick={onSave}>
            Save Shipment Changes
          </Button>
        </Stack>
      </Container>
    </Drawer>
  );
}

export const meta: MetaFunction = () => {
  return [
    { title: "EasyPost Shipping Export" },
    {
      name: "description",
      content:
        "Load live TCGPlayer seller orders or upload CSV exports, then build and buy EasyPost shipments.",
    },
  ];
};

export async function loader() {
  const config = await getShippingExportConfig();
  return data({
    config,
    environmentStatus: getEasyPostEnvironmentStatus(),
  });
}

export default function ShippingExportRoute() {
  const { config, environmentStatus } = useLoaderData<typeof loader>();
  const [sourceOrders, setSourceOrders] = useState<TcgPlayerShippingOrder[]>(
    [],
  );
  const [orders, setOrders] = useState<TcgPlayerShippingOrder[]>([]);
  const [shipments, setShipments] = useState<EasyPostShipment[]>([]);
  const [shipmentToOrderMap, setShipmentToOrderMap] =
    useState<ShipmentToOrderMap>({});
  const [sellerKeyInput, setSellerKeyInput] = useState(config.defaultSellerKey);
  const [singleOrderNumberInput, setSingleOrderNumberInput] = useState("");
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [loadedSourceLabel, setLoadedSourceLabel] = useState("");
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedShipment, setSelectedShipment] =
    useState<EasyPostShipment | null>(null);
  const [selectedShipmentReference, setSelectedShipmentReference] = useState<
    string | null
  >(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [outboundPurchaseResultsByReference, setOutboundPurchaseResultsByReference] =
    useState<Record<string, PurchaseEntry>>({});
  const [returnPurchaseResultsByReference, setReturnPurchaseResultsByReference] =
    useState<Record<string, PurchaseEntry>>({});
  const [batchLabelResultsBySize, setBatchLabelResultsBySize] = useState<
    Partial<Record<LabelSize, ShippingPostageBatchLabelResult>>
  >({});
  const [isLoadingExistingPostage, setIsLoadingExistingPostage] =
    useState(false);
  const [isLoadingLiveOrders, setIsLoadingLiveOrders] = useState(false);
  const [isLoadingSingleOrder, setIsLoadingSingleOrder] = useState(false);
  const [isGeneratingPullSheet, setIsGeneratingPullSheet] = useState(false);
  const [packingSlipAction, setPackingSlipAction] = useState<
    "download" | "open" | null
  >(null);
  const [generatingBatchLabelSize, setGeneratingBatchLabelSize] =
    useState<LabelSize | null>(null);
  const [purchasingLabelSize, setPurchasingLabelSize] =
    useState<LabelSize | null>(null);
  const [purchasingActionKey, setPurchasingActionKey] = useState<string | null>(
    null,
  );
  const [isApplyingTracking, setIsApplyingTracking] = useState(false);
  const [trackingApplyResults, setTrackingApplyResults] = useState<
    ShippingTrackingApplyResult[]
  >([]);
  const [isSendingShippedMessages, setIsSendingShippedMessages] =
    useState(false);
  const [shippedMessageResults, setShippedMessageResults] = useState<
    ShippingShippedMessageResult[]
  >([]);

  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;
  const availableLabelSizes = getAllLabelSizes().filter((labelSize) =>
    shipments.some((shipment) => shipment.options.label_size === labelSize),
  );
  const loadedOrderNumbers = [
    ...new Set(
      sourceOrders
        .map((order) => order["Order #"].trim())
        .filter(Boolean),
    ),
  ];
  const trackingApplyItems = buildTrackingApplyItems(
    shipments,
    shipmentToOrderMap,
    outboundPurchaseResultsByReference,
  );
  const shippedMessageItems = buildShippedMessageItems(
    shipments,
    sellerKeyInput,
    shipmentToOrderMap,
    outboundPurchaseResultsByReference,
  );
  const appliedTrackingCount = trackingApplyResults.filter(
    (result) => result.status === "applied",
  ).length;
  const failedTrackingResults = trackingApplyResults.filter(
    (result) => result.status === "failed",
  );
  const sentShippedMessageCount = shippedMessageResults.filter(
    (result) => result.status === "sent",
  ).length;
  const failedShippedMessageResults = shippedMessageResults.filter(
    (result) => result.status === "failed",
  );

  const applyOutboundPurchaseResults = (results: Record<string, PurchaseEntry>) => {
    setOutboundPurchaseResultsByReference(results);
  };

  const getOrderNumbersForShipment = (shipmentReference: string) =>
    shipmentToOrderMap[shipmentReference] ?? [shipmentReference];

  const mergePurchaseResults = (
    previousResults: Record<string, PurchaseEntry>,
    mode: EasyPostMode,
    results: ShippingPostagePurchaseResult[],
  ) => {
    const nextResults = { ...previousResults };

    for (const result of results) {
      const previousResult = previousResults[result.reference];

      if (
        previousResult?.result.status === "purchased" &&
        result.status === "skipped"
      ) {
        continue;
      }

      nextResults[result.reference] = {
        mode,
        result,
      };
    }

    return nextResults;
  };

  const loadExistingPostage = async (
    nextShipments: EasyPostShipment[],
    nextShipmentToOrderMap: ShipmentToOrderMap,
  ) => {
    applyOutboundPurchaseResults({});
    setReturnPurchaseResultsByReference({});
    setBatchLabelResultsBySize({});
    setTrackingApplyResults([]);
    setShippedMessageResults([]);

    if (nextShipments.length === 0) {
      return;
    }

    setIsLoadingExistingPostage(true);

    try {
      const response = await fetch("/api/shipping-export/postage-lookups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shipments: nextShipments.map((shipment) => ({
            shipmentReference: shipment.reference,
            orderNumbers: nextShipmentToOrderMap[shipment.reference] ?? [
              shipment.reference,
            ],
          })),
        }),
      });

      const payload = (await response.json()) as
        | ShippingPostageLookupResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload
            ? payload.error ?? "Failed to load saved postage."
            : "Failed to load saved postage.",
        );
      }

      const lookupResponse = payload as ShippingPostageLookupResponse;

      applyOutboundPurchaseResults(
        Object.fromEntries(
          lookupResponse.results.map((entry) => [
            entry.shipmentReference,
            {
              mode: entry.mode,
              result: entry.result,
            },
          ]),
        ),
      );
    } catch (lookupError) {
      console.error("Failed to load saved postage labels", lookupError);
      applyOutboundPurchaseResults({});
    } finally {
      setIsLoadingExistingPostage(false);
    }
  };

  const applyOrderSource = async (
    nextSourceOrders: TcgPlayerShippingOrder[],
    nextSourceLabel: string,
    nextWarnings: string[] = [],
  ) => {
    const nextState = updateOrderDerivedState(nextSourceOrders, config);

    setSourceOrders(nextSourceOrders);
    setOrders(nextState.orders);
    setShipments(nextState.shipments);
    setShipmentToOrderMap(nextState.shipmentToOrderMap);
    setLoadedSourceLabel(nextSourceLabel);
    setLoadWarnings(nextWarnings);
    setBatchLabelResultsBySize({});
    setTrackingApplyResults([]);
    setShippedMessageResults([]);
    setError(null);
    await loadExistingPostage(
      nextState.shipments,
      nextState.shipmentToOrderMap,
    );
  };

  const handleFileInput = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const csvText = await file.text();
      const parsedOrders = parseShippingOrdersCsv(csvText);

      if (parsedOrders.length === 0) {
        throw new Error("No valid order rows were found in the uploaded CSV.");
      }

      setUploadedFileName(file.name);
      await applyOrderSource(parsedOrders, `CSV export: ${file.name}`);
    } catch (uploadError) {
      setError(String(uploadError));
    }
  };

  const handleLoadLiveOrders = async () => {
    setIsLoadingLiveOrders(true);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sellerKey: sellerKeyInput.trim(),
        }),
      });

      const payload = (await response.json()) as
        | ShippingLiveOrderLoadResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload
            ? payload.error ?? "Failed to load live seller orders."
            : "Failed to load live seller orders.",
        );
      }

      const liveOrderResponse = payload as ShippingLiveOrderLoadResponse;

      setSellerKeyInput(liveOrderResponse.sellerKey);
      setUploadedFileName("");
      await applyOrderSource(
        liveOrderResponse.orders,
        `Live seller orders: ${liveOrderResponse.sellerKey}`,
        liveOrderResponse.warnings ?? [],
      );
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setIsLoadingLiveOrders(false);
    }
  };

  const handleLoadSingleOrder = async () => {
    const normalizedOrderNumber = singleOrderNumberInput.trim();

    if (!normalizedOrderNumber) {
      setError("Enter a TCGPlayer order number to load a single order.");
      return;
    }

    setIsLoadingSingleOrder(true);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sellerKey: sellerKeyInput.trim(),
          orderNumber: normalizedOrderNumber,
        }),
      });

      const payload = (await response.json()) as
        | ShippingLiveOrderLoadResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload
            ? payload.error ?? "Failed to load the requested TCGPlayer order."
            : "Failed to load the requested TCGPlayer order.",
        );
      }

      const singleOrderResponse = payload as ShippingLiveOrderLoadResponse;

      if (singleOrderResponse.sellerKey) {
        setSellerKeyInput(singleOrderResponse.sellerKey);
      }

      setSingleOrderNumberInput(
        singleOrderResponse.loadedOrderNumbers[0] ?? normalizedOrderNumber,
      );
      setUploadedFileName("");
      await applyOrderSource(
        singleOrderResponse.orders,
        `Single TCGPlayer order: ${
          singleOrderResponse.loadedOrderNumbers[0] ?? normalizedOrderNumber
        }`,
        singleOrderResponse.warnings ?? [],
      );
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setIsLoadingSingleOrder(false);
    }
  };

  const handleRebuildShipments = async () => {
    if (sourceOrders.length === 0) {
      return;
    }

    const nextState = updateOrderDerivedState(sourceOrders, config);
    setOrders(nextState.orders);
    setShipments(nextState.shipments);
    setShipmentToOrderMap(nextState.shipmentToOrderMap);
    setBatchLabelResultsBySize({});
    setError(null);
    await loadExistingPostage(
      nextState.shipments,
      nextState.shipmentToOrderMap,
    );
  };

  const handleDownloadAll = () => {
    for (const labelSize of getAllLabelSizes()) {
      const labelShipments = getShipmentsForLabelSize(shipments, labelSize);

      if (labelShipments.length > 0) {
        downloadCsvFile(`EasyPost_Shipments_${labelSize}`, labelShipments);
      }
    }
  };

  const handleOpenPullSheet = async () => {
    if (loadedOrderNumbers.length === 0 || isGeneratingPullSheet) {
      return;
    }

    const pullSheetWindow = window.open("about:blank", "_blank");

    setIsGeneratingPullSheet(true);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/pull-sheet-export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderNumbers: loadedOrderNumbers,
          timezoneOffset: -new Date().getTimezoneOffset() / 60,
        }),
      });

      if (!response.ok) {
        let message = "Failed to generate pull sheet export.";

        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) {
            message = payload.error;
          }
        } catch {
          // Ignore parsing failures and use the default message.
        }

        throw new Error(message);
      }

      const csvText = await response.text();
      const importKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      window.localStorage.setItem(
        `pull-sheet-import:${importKey}`,
        JSON.stringify({
          csvText,
          fileName: `pull-sheet-${Date.now()}.csv`,
        }),
      );

      const pullSheetUrl = `/pull-sheet?importKey=${encodeURIComponent(importKey)}`;

      if (pullSheetWindow) {
        pullSheetWindow.location.href = pullSheetUrl;
        pullSheetWindow.focus();
      } else {
        window.open(pullSheetUrl, "_blank");
      }
    } catch (pullSheetError) {
      if (pullSheetWindow && !pullSheetWindow.closed) {
        pullSheetWindow.close();
      }

      setError(String(pullSheetError));
    } finally {
      setIsGeneratingPullSheet(false);
    }
  };

  const handlePackingSlipExport = async (
    action: "download" | "open",
  ) => {
    if (loadedOrderNumbers.length === 0 || packingSlipAction !== null) {
      return;
    }

    const packingSlipWindow =
      action === "open" ? window.open("about:blank", "_blank") : null;

    setPackingSlipAction(action);
    setError(null);

    try {
      const response = await fetch(
        "/api/shipping-export/packing-slips-export",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orderNumbers: loadedOrderNumbers,
            timezoneOffset: -new Date().getTimezoneOffset() / 60,
          }),
        },
      );

      if (!response.ok) {
        let message = "Failed to generate packing slips export.";

        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) {
            message = payload.error;
          }
        } catch {
          // Ignore parsing failures and use the default message.
        }

        throw new Error(message);
      }

      const pdfBlob = await response.blob();
      const fileName = getFileNameFromContentDisposition(
        response.headers.get("Content-Disposition"),
        `packing-slips-${Date.now()}.pdf`,
      );

      if (action === "open") {
        openBlobInNewTab(pdfBlob, packingSlipWindow);
      } else {
        downloadBlobFile(pdfBlob, fileName);
      }
    } catch (packingSlipError) {
      if (packingSlipWindow && !packingSlipWindow.closed) {
        packingSlipWindow.close();
      }

      setError(String(packingSlipError));
    } finally {
      setPackingSlipAction(null);
    }
  };

  const handleDownloadShipment = (shipment: EasyPostShipment) => {
    downloadCsvFile(`EasyPost_Shipments_${shipment.options.label_size}`, [
      shipment,
    ]);
  };

  const handleDownloadReturnShipment = (shipment: EasyPostShipment) => {
    const returnShipment = createReturnShipment(shipment);
    downloadCsvFile(`EasyPost_Returns_${returnShipment.options.label_size}`, [
      returnShipment,
    ]);
  };

  const handleOpenEditDrawer = (shipment: EasyPostShipment) => {
    setSelectedShipment(shipment);
    setSelectedShipmentReference(shipment.reference);
    setDrawerOpen(true);
  };

  const handleSaveShipmentChanges = () => {
    if (!selectedShipment || !selectedShipmentReference) {
      return;
    }

    setShipments((previousShipments) =>
      previousShipments.map((shipment) =>
        shipment.reference === selectedShipmentReference
          ? selectedShipment
          : shipment,
      ),
    );
    setDrawerOpen(false);
    setSelectedShipmentReference(selectedShipment.reference);
  };

  const purchaseShipments = async ({
    labelSize,
    shipmentItems,
    direction,
    purchaseScope,
  }: {
    labelSize: LabelSize;
    shipmentItems: Array<{
      shipment: EasyPostShipment;
      orderNumbers: string[];
    }>;
    direction: ShippingPostageDirection;
    purchaseScope: ShippingPostagePurchaseScope;
  }) => {
    if (direction === "outbound") {
      setTrackingApplyResults([]);
    }

    const response = await fetch("/api/shipping-export/postages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        labelSize,
        direction,
        purchaseScope,
        shipments: shipmentItems,
      }),
    });

    const payload = (await response.json()) as
      | ShippingPostagePurchaseResponse
      | { error?: string };

    if (!response.ok) {
      throw new Error(
        "error" in payload
          ? payload.error ?? "Failed to buy postage."
          : "Failed to buy postage.",
      );
    }

    const purchaseResponse = payload as ShippingPostagePurchaseResponse;

    if (direction === "return") {
      setReturnPurchaseResultsByReference((previousResults) =>
        mergePurchaseResults(
          previousResults,
          purchaseResponse.mode,
          purchaseResponse.results,
        ),
      );
      return;
    }

    setOutboundPurchaseResultsByReference((previousResults) =>
      mergePurchaseResults(
        previousResults,
        purchaseResponse.mode,
        purchaseResponse.results,
      ),
    );

    if (purchaseScope === "bulk") {
      setBatchLabelResultsBySize((previousResults) => ({
        ...previousResults,
        [labelSize]: purchaseResponse.batchLabel,
      }));
    }
  };

  const purchasePostageForLabelSize = async (labelSize: LabelSize) => {
    const labelShipments = getShipmentsForLabelSize(shipments, labelSize);

    if (labelShipments.length === 0) {
      return;
    }

    await purchaseShipments({
      labelSize,
      direction: "outbound",
      purchaseScope: "bulk",
      shipmentItems: labelShipments.map((shipment) => ({
        shipment,
        orderNumbers: getOrderNumbersForShipment(shipment.reference),
      })),
    });
  };

  const getSavedPurchasedEntriesForLabelSize = (labelSize: LabelSize) =>
    getShipmentsForLabelSize(shipments, labelSize)
      .map((shipment) => ({
        shipment,
        purchaseEntry: outboundPurchaseResultsByReference[shipment.reference],
      }))
      .filter(
        (
          entry,
        ): entry is {
          shipment: EasyPostShipment;
          purchaseEntry: {
            mode: EasyPostMode;
            result: ShippingPostagePurchaseResult;
          };
        } =>
          Boolean(
            entry.purchaseEntry &&
              entry.purchaseEntry.result.status !== "failed" &&
              entry.purchaseEntry.result.easypostShipmentId,
          ),
      );

  const handleGenerateBatchLabelFromSavedPostage = async (
    labelSize: LabelSize,
  ) => {
    const savedEntries = getSavedPurchasedEntriesForLabelSize(labelSize);

    if (savedEntries.length === 0 || generatingBatchLabelSize) {
      return;
    }

    const uniqueModes = [
      ...new Set(savedEntries.map((entry) => entry.purchaseEntry.mode)),
    ];

    if (uniqueModes.length !== 1) {
      setBatchLabelResultsBySize((previousResults) => ({
        ...previousResults,
        [labelSize]: {
          status: "failed",
          shipmentReferences: savedEntries.map(
            (entry) => entry.shipment.reference,
          ),
          message:
            "Saved labels for this size span multiple EasyPost modes. Rebuy or regroup them to generate one batch PDF.",
        },
      }));
      return;
    }

    setGeneratingBatchLabelSize(labelSize);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/batch-labels", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: uniqueModes[0],
          labelSize,
          shipments: savedEntries.map(
            (entry): ShippingPostageBatchLabelRequestItem => ({
              shipmentReference: entry.shipment.reference,
              easypostShipmentId:
                entry.purchaseEntry.result.easypostShipmentId!,
            }),
          ),
        }),
      });

      const payload = (await response.json()) as
        | ShippingPostageBatchLabelResult
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload
            ? payload.error ?? "Failed to create the batch label PDF."
            : "Failed to create the batch label PDF.",
        );
      }

      setBatchLabelResultsBySize((previousResults) => ({
        ...previousResults,
        [labelSize]: payload as ShippingPostageBatchLabelResult,
      }));
    } catch (generationError) {
      setError(String(generationError));
    } finally {
      setGeneratingBatchLabelSize(null);
    }
  };

  const handleBuyPostage = async () => {
    if (
      availableLabelSizes.length === 0 ||
      purchasingLabelSize ||
      purchasingActionKey
    ) {
      return;
    }

    setError(null);

    try {
      for (const labelSize of availableLabelSizes) {
        setPurchasingLabelSize(labelSize as LabelSize);
        await purchasePostageForLabelSize(labelSize as LabelSize);
      }
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setPurchasingLabelSize(null);
    }
  };

  const handleBuyShipment = async (shipment: EasyPostShipment) => {
    if (purchasingLabelSize || purchasingActionKey) {
      return;
    }

    setPurchasingActionKey(`outbound:${shipment.reference}`);
    setError(null);

    try {
      await purchaseShipments({
        labelSize: shipment.options.label_size,
        direction: "outbound",
        purchaseScope: "single",
        shipmentItems: [
          {
            shipment,
            orderNumbers: getOrderNumbersForShipment(shipment.reference),
          },
        ],
      });
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setPurchasingActionKey(null);
    }
  };

  const handleBuyReturnLabel = async (shipment: EasyPostShipment) => {
    if (purchasingLabelSize || purchasingActionKey) {
      return;
    }

    setPurchasingActionKey(`return:${shipment.reference}`);
    setError(null);

    try {
      const returnShipment = createReturnShipment(shipment);

      await purchaseShipments({
        labelSize: returnShipment.options.label_size,
        direction: "return",
        purchaseScope: "single",
        shipmentItems: [
          {
            shipment: returnShipment,
            orderNumbers: getOrderNumbersForShipment(shipment.reference),
          },
        ],
      });
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setPurchasingActionKey(null);
    }
  };

  const handleApplyTracking = async () => {
    if (
      trackingApplyItems.length === 0 ||
      isApplyingTracking ||
      isSendingShippedMessages ||
      purchasingLabelSize ||
      purchasingActionKey
    ) {
      return;
    }

    setIsApplyingTracking(true);
    setTrackingApplyResults([]);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-tracking", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          updates: trackingApplyItems,
        }),
      });

      const payload = (await response.json()) as
        | ShippingTrackingApplyResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload
            ? payload.error ?? "Failed to apply tracking to TCGPlayer orders."
            : "Failed to apply tracking to TCGPlayer orders.",
        );
      }

      const trackingResponse = payload as ShippingTrackingApplyResponse;
      setTrackingApplyResults(trackingResponse.results);
    } catch (trackingError) {
      setError(String(trackingError));
    } finally {
      setIsApplyingTracking(false);
    }
  };

  const handleSendShippedMessages = async () => {
    if (
      shippedMessageItems.length === 0 ||
      isSendingShippedMessages ||
      isApplyingTracking ||
      purchasingLabelSize ||
      purchasingActionKey
    ) {
      return;
    }

    setIsSendingShippedMessages(true);
    setShippedMessageResults([]);
    setError(null);

    try {
      const response = await fetch(
        "/api/shipping-export/tcgplayer-shipped-messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: shippedMessageItems,
          }),
        },
      );

      const payload = (await response.json()) as
        | ShippingShippedMessageResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload
            ? payload.error ?? "Failed to send shipped messages to TCGPlayer."
            : "Failed to send shipped messages to TCGPlayer.",
        );
      }

      const shippedMessageResponse = payload as ShippingShippedMessageResponse;
      setShippedMessageResults(shippedMessageResponse.results);
    } catch (shippedMessageError) {
      setError(String(shippedMessageError));
    } finally {
      setIsSendingShippedMessages(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 1400, mx: "auto", p: 3 }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ md: "center" }}
      >
        <Box>
          <Typography variant="h4" component="h1" gutterBottom>
            EasyPost Shipping Export
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            flexWrap="wrap"
          >
            <Chip
              label={
                config.easypostMode === "test" ? "Test Mode" : "Production Mode"
              }
              color={config.easypostMode === "test" ? "warning" : "error"}
            />
            <Chip
              label={
                selectedModeHasApiKey ? "API Key Ready" : "Missing API Key"
              }
              color={selectedModeHasApiKey ? "success" : "warning"}
              variant={selectedModeHasApiKey ? "filled" : "outlined"}
            />
          </Stack>
        </Box>
      </Stack>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        Load live TCGPlayer seller orders first, or fall back to a shipping
        export CSV, then review EasyPost-ready shipment rows and buy postage or
        download batch files by label size.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        Manage sender address, package thresholds, label defaults, and the saved
        default seller key in{" "}
        <Link
          to="/shipping-configuration"
          style={{ color: "inherit", fontWeight: 600 }}
        >
          Shipping Configuration
        </Link>
        . After changing settings, use <strong>Rebuild Shipments</strong> to
        regenerate rows from the current order source.
      </Alert>

      {!selectedModeHasApiKey && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {config.easypostMode === "test"
            ? "EASYPOST_TEST_API_KEY is not set. Direct postage purchase is disabled, but CSV export still works."
            : "EASYPOST_PRODUCTION_API_KEY is not set. Direct postage purchase is disabled, but CSV export still works."}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loadWarnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
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

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          1. Load Orders
        </Typography>
        <Stack spacing={3}>
          <Box>
            <Typography variant="subtitle1" gutterBottom>
              Live TCGPlayer Seller Orders
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Load live `Ready to Ship` orders from the last three months using
              your saved seller key or an override entered here.
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
              onChange={(event) => setSellerKeyInput(event.target.value)}
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
              onClick={() => void handleLoadLiveOrders()}
              disabled={isLoadingLiveOrders || isLoadingSingleOrder}
              startIcon={
                isLoadingLiveOrders ? (
                  <CircularProgress color="inherit" size={18} />
                ) : undefined
              }
            >
              {isLoadingLiveOrders
                ? "Loading Live Orders..."
                : "Load Live TCGPlayer Orders"}
            </Button>
            <Button
              variant="outlined"
              onClick={() => void handleRebuildShipments()}
              disabled={
                sourceOrders.length === 0 ||
                isLoadingLiveOrders ||
                isLoadingSingleOrder
              }
            >
              Rebuild Shipments
            </Button>
          </Stack>

          <Box>
            <Typography variant="subtitle1" gutterBottom>
              Single Order Lookup
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Load one TCGPlayer order by number when you want to inspect it and
              buy postage without pulling the full live queue. The seller key
              above is used for the lookup.
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
              onChange={(event) => setSingleOrderNumberInput(event.target.value)}
              placeholder="Enter order number"
              sx={{ minWidth: { xs: "100%", md: 320 } }}
            />
            <Button
              variant="contained"
              color="secondary"
              onClick={() => void handleLoadSingleOrder()}
              disabled={isLoadingSingleOrder || isLoadingLiveOrders}
              startIcon={
                isLoadingSingleOrder ? (
                  <CircularProgress color="inherit" size={18} />
                ) : undefined
              }
            >
              {isLoadingSingleOrder
                ? "Looking Up Order..."
                : "Lookup Single Order"}
            </Button>
          </Stack>

          <Divider />

          <Box>
            <Typography variant="subtitle1" gutterBottom>
              CSV Fallback
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              If live loading is unavailable or you need to work from an export,
              upload a TCGPlayer shipping export CSV instead.
            </Typography>
            <Button variant="outlined" component="label">
              Upload TCGPlayer Shipping Export CSV
              <input
                type="file"
                hidden
                accept=".csv"
                onChange={handleFileInput}
                onClick={(event) => {
                  (event.target as HTMLInputElement).value = "";
                }}
              />
            </Button>
          </Box>

          {(loadedSourceLabel ||
            uploadedFileName ||
            isLoadingExistingPostage) && (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              flexWrap="wrap"
            >
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
              {uploadedFileName && (
                <Typography variant="body2" color="text.secondary">
                  {uploadedFileName}
                </Typography>
              )}
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
        </Stack>
      </Paper>

      {shipments.length > 0 ? (
        <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ md: "center" }}
            sx={{ mb: 2 }}
          >
            <Typography variant="h6">2. Review Shipments</Typography>
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={1}
              useFlexGap
              flexWrap="wrap"
            >
              <Button
                variant="outlined"
                startIcon={
                  isGeneratingPullSheet ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : (
                    <OpenInNewIcon />
                  )
                }
                onClick={() => void handleOpenPullSheet()}
                disabled={sourceOrders.length === 0 || isGeneratingPullSheet}
              >
                {isGeneratingPullSheet
                  ? "Opening Pull Sheet..."
                  : "Open Pull Sheet"}
              </Button>
              <Button
                variant="outlined"
                startIcon={
                  packingSlipAction === "open" ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : (
                    <OpenInNewIcon />
                  )
                }
                onClick={() => void handlePackingSlipExport("open")}
                disabled={sourceOrders.length === 0 || packingSlipAction !== null}
              >
                {packingSlipAction === "open"
                  ? "Opening Packing Slips..."
                  : "Open Packing Slips PDF"}
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
                onClick={() => void handlePackingSlipExport("download")}
                disabled={sourceOrders.length === 0 || packingSlipAction !== null}
              >
                {packingSlipAction === "download"
                  ? "Downloading Packing Slips..."
                  : "Download Packing Slips PDF"}
              </Button>
              <Button
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={handleDownloadAll}
              >
                Download EasyPost Batch File(s)
              </Button>
              <Button
                variant="outlined"
                onClick={() => void handleApplyTracking()}
                disabled={
                  trackingApplyItems.length === 0 ||
                  isApplyingTracking ||
                  isSendingShippedMessages ||
                  purchasingLabelSize !== null ||
                  purchasingActionKey !== null
                }
                startIcon={
                  isApplyingTracking ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : undefined
                }
              >
                {isApplyingTracking
                  ? "Applying Tracking..."
                  : "Apply Tracking to TCGPlayer"}
              </Button>
              <Button
                variant="outlined"
                onClick={() => void handleSendShippedMessages()}
                disabled={
                  shippedMessageItems.length === 0 ||
                  isSendingShippedMessages ||
                  isApplyingTracking ||
                  purchasingLabelSize !== null ||
                  purchasingActionKey !== null
                }
                startIcon={
                  isSendingShippedMessages ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : undefined
                }
              >
                {isSendingShippedMessages
                  ? "Sending Shipped Messages..."
                  : "Send Shipped Messages"}
              </Button>
              <Button
                variant="contained"
                color={config.easypostMode === "test" ? "warning" : "primary"}
                onClick={() => void handleBuyPostage()}
                disabled={
                  availableLabelSizes.length === 0 ||
                  !selectedModeHasApiKey ||
                  purchasingLabelSize !== null ||
                  purchasingActionKey !== null
                }
                startIcon={
                  purchasingLabelSize ? (
                    <CircularProgress color="inherit" size={18} />
                  ) : undefined
                }
              >
                {purchasingLabelSize
                  ? `Buying ${purchasingLabelSize} Postage...`
                  : "Buy Postage"}
              </Button>
            </Stack>
          </Stack>
          {trackingApplyResults.length > 0 && (
            <Alert
              severity={failedTrackingResults.length > 0 ? "warning" : "success"}
              sx={{ mb: 2 }}
            >
              <Stack spacing={0.5}>
                <Typography variant="body2" fontWeight={600}>
                  Applied tracking to {appliedTrackingCount} order
                  {appliedTrackingCount === 1 ? "" : "s"}.
                </Typography>
                {failedTrackingResults.length > 0 && (
                  <Typography variant="body2">
                    {failedTrackingResults.length} order
                    {failedTrackingResults.length === 1 ? "" : "s"} could not be
                    updated.
                  </Typography>
                )}
                {failedTrackingResults.map((result) => (
                  <Typography
                    key={result.orderNumber}
                    variant="body2"
                    color="text.secondary"
                  >
                    {result.orderNumber}: {result.error}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}
          {shippedMessageResults.length > 0 && (
            <Alert
              severity={
                failedShippedMessageResults.length > 0 ? "warning" : "success"
              }
              sx={{ mb: 2 }}
            >
              <Stack spacing={0.5}>
                <Typography variant="body2" fontWeight={600}>
                  Sent shipped messages to {sentShippedMessageCount} order
                  {sentShippedMessageCount === 1 ? "" : "s"}.
                </Typography>
                {failedShippedMessageResults.length > 0 && (
                  <Typography variant="body2">
                    {failedShippedMessageResults.length} order
                    {failedShippedMessageResults.length === 1 ? "" : "s"} could
                    not be messaged.
                  </Typography>
                )}
                {failedShippedMessageResults.map((result) => (
                  <Typography
                    key={result.orderNumber}
                    variant="body2"
                    color="text.secondary"
                  >
                    {result.orderNumber}: {result.error}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}
          {(() => {
            const letterCount = shipments.filter(
              (s) => s.parcel.predefined_package === "Letter",
            ).length;
            const flatCount = shipments.filter(
              (s) => s.parcel.predefined_package === "Flat",
            ).length;
            const parcelCount = shipments.filter(
              (s) => s.parcel.predefined_package === "Parcel",
            ).length;
            const purchasedCount = shipments.filter(
              (s) =>
                outboundPurchaseResultsByReference[s.reference]?.result.status ===
                "purchased",
            ).length;
            return (
              <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 2 }}>
                <Chip label={`${shipments.length} shipments`} size="small" />
                {letterCount > 0 && (
                  <Chip
                    label={`${letterCount} Letter`}
                    size="small"
                    variant="outlined"
                  />
                )}
                {flatCount > 0 && (
                  <Chip
                    label={`${flatCount} Flat`}
                    size="small"
                    variant="outlined"
                  />
                )}
                {parcelCount > 0 && (
                  <Chip
                    label={`${parcelCount} Parcel`}
                    size="small"
                    variant="outlined"
                  />
                )}
                {purchasedCount > 0 && (
                  <Chip
                    label={`${purchasedCount} postage purchased`}
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                )}
                {trackingApplyItems.length > 0 && (
                  <Chip
                    label={`${trackingApplyItems.length} tracking-ready orders`}
                    size="small"
                    color="info"
                    variant="outlined"
                  />
                )}
                {shippedMessageItems.length > 0 && (
                  <Chip
                    label={`${shippedMessageItems.length} message-ready orders`}
                    size="small"
                    color="secondary"
                    variant="outlined"
                  />
                )}
                {purchasedCount < shipments.length &&
                  !isLoadingExistingPostage && (
                    <Chip
                      label={`${shipments.length - purchasedCount} pending`}
                      size="small"
                      color="warning"
                      variant="outlined"
                    />
                  )}
              </Stack>
            );
          })()}
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
                  const order = orders.find(
                    (candidate) => candidate["Order #"] === shipment.reference,
                  );
                  const purchaseEntry =
                    outboundPurchaseResultsByReference[shipment.reference];
                  const returnPurchaseEntry =
                    returnPurchaseResultsByReference[shipment.reference];
                  const isBuyingOutbound =
                    purchasingActionKey === `outbound:${shipment.reference}`;
                  const isBuyingReturn =
                    purchasingActionKey === `return:${shipment.reference}`;

                  return (
                    <TableRow key={shipment.reference}>
                      <TableCell>
                        <Stack spacing={0.5}>
                          {(
                            shipmentToOrderMap[shipment.reference] ?? [
                              shipment.reference,
                            ]
                          ).map((num) => (
                            <Typography key={num} variant="body2">
                              {num}
                            </Typography>
                          ))}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <AddressBlock address={shipment.to_address} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {shipment.parcel.predefined_package} &bull;{" "}
                          {shipment.parcel.weight}oz
                          {shipment.options.delivery_confirmation ===
                            "SIGNATURE" && (
                            <Chip
                              label="Sig. Required"
                              size="small"
                              color="warning"
                              sx={{ ml: 1 }}
                            />
                          )}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {shipment.parcel.length}&times;
                          {shipment.parcel.width}&times;
                          {shipment.parcel.height} in
                          {order
                            ? ` • ${order["Item Count"]} items • $${order["Value Of Products"]}`
                            : ""}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {shipment.service}
                        </Typography>
                        <Chip
                          label={shipment.options.label_size}
                          size="small"
                          variant="outlined"
                          sx={{ mt: 0.5 }}
                        />
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
                                Rate:{" "}
                                {purchaseEntry.result.selectedRate.service} $
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
                            {!purchaseEntry.result.labelPdfUrl &&
                              purchaseEntry.result.labelUrl && (
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
                            color={
                              config.easypostMode === "test"
                                ? "warning"
                                : "primary"
                            }
                            onClick={() => void handleBuyShipment(shipment)}
                            disabled={
                              !selectedModeHasApiKey ||
                              purchasingLabelSize !== null ||
                              purchasingActionKey !== null
                            }
                            startIcon={
                              isBuyingOutbound ? (
                                <CircularProgress color="inherit" size={16} />
                              ) : undefined
                            }
                          >
                            {isBuyingOutbound
                              ? "Buying..."
                              : purchaseEntry?.result.status === "purchased" &&
                                  purchaseEntry.mode === config.easypostMode
                                ? "Buy Again"
                                : "Buy Postage"}
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => void handleBuyReturnLabel(shipment)}
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
                          {!returnPurchaseEntry?.result.labelPdfUrl &&
                            returnPurchaseEntry?.result.labelUrl && (
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
                              <IconButton
                                onClick={() => handleOpenEditDrawer(shipment)}
                                color="primary"
                              >
                                <EditIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Download Shipment CSV" arrow>
                              <IconButton
                                onClick={() => handleDownloadShipment(shipment)}
                                color="primary"
                              >
                                <DownloadIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Download Return CSV" arrow>
                              <IconButton
                                onClick={() =>
                                  handleDownloadReturnShipment(shipment)
                                }
                                color="primary"
                              >
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
        </Paper>
      ) : (
        <Paper
          sx={{ p: 6, textAlign: "center", backgroundColor: "action.hover" }}
          elevation={0}
        >
          <Typography variant="h6" color="text.secondary">
            Load live seller orders or upload a TCGPlayer shipping export CSV to
            get started.
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
            Use the live order loader above, or fall back to CSV upload. Saved
            shipping settings are managed from{" "}
            <Link to="/shipping-configuration" style={{ color: "inherit" }}>
              Shipping Configuration
            </Link>
            .
          </Typography>
        </Paper>
      )}

      {Object.keys(outboundPurchaseResultsByReference).length > 0 && (
        <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            3. Batch Labels & Postage
          </Typography>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            flexWrap="wrap"
          >
            {availableLabelSizes.map((labelSize) => {
              const batchLabel =
                batchLabelResultsBySize[labelSize as LabelSize];
              const savedPurchasedEntries =
                getSavedPurchasedEntriesForLabelSize(labelSize as LabelSize);
              const savedModes = [
                ...new Set(
                  savedPurchasedEntries.map(
                    (entry) => entry.purchaseEntry.mode,
                  ),
                ),
              ];
              const canGenerateBatchLabelFromSavedPostage =
                savedPurchasedEntries.length > 0 && savedModes.length === 1;

              return (
                <Paper
                  key={labelSize}
                  variant="outlined"
                  sx={{ p: 2, minWidth: 240 }}
                >
                  <Stack spacing={1.5} alignItems="flex-start">
                    <Typography variant="subtitle2">
                      {labelSize} Labels
                    </Typography>
                    {batchLabel?.status === "ready" && batchLabel.labelUrl && (
                      <Button
                        component="a"
                        href={batchLabel.labelUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="outlined"
                      >
                        Open Batch Label PDF
                      </Button>
                    )}
                    {batchLabel?.status === "ready" && (
                      <Chip
                        label={`Batch PDF Ready (${batchLabel.shipmentReferences.length})`}
                        color="success"
                        size="small"
                      />
                    )}
                    {batchLabel?.status === "pending" && (
                      <Typography variant="body2" color="text.secondary">
                        {batchLabel.message ??
                          "EasyPost is still generating the batch PDF."}
                      </Typography>
                    )}
                    {batchLabel?.status === "failed" && (
                      <Typography variant="body2" color="error">
                        {batchLabel.message ??
                          "Failed to generate the batch PDF."}
                      </Typography>
                    )}
                    {batchLabel?.status === "skipped" && batchLabel.message && (
                      <Typography variant="body2" color="text.secondary">
                        {batchLabel.message}
                      </Typography>
                    )}
                    {!batchLabel && canGenerateBatchLabelFromSavedPostage && (
                      <>
                        <Chip
                          label={`Saved Labels Ready (${savedPurchasedEntries.length})`}
                          color="info"
                          size="small"
                          variant="outlined"
                        />
                        <Button
                          variant="outlined"
                          onClick={() =>
                            void handleGenerateBatchLabelFromSavedPostage(
                              labelSize as LabelSize,
                            )
                          }
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
                    {!batchLabel &&
                      savedPurchasedEntries.length > 0 &&
                      !canGenerateBatchLabelFromSavedPostage && (
                        <Typography variant="body2" color="text.secondary">
                          Saved labels exist for this size, but they span
                          multiple EasyPost modes and cannot be combined
                          automatically.
                        </Typography>
                      )}
                    {!batchLabel && savedPurchasedEntries.length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        Buy postage to generate a combined PDF for this label
                        size.
                      </Typography>
                    )}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        </Paper>
      )}

      <ShipmentEditDrawer
        shipment={selectedShipment}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSave={handleSaveShipmentChanges}
        onChange={(changes) =>
          setSelectedShipment((previousShipment) =>
            previousShipment
              ? { ...previousShipment, ...changes }
              : previousShipment,
          )
        }
      />
    </Box>
  );
}
