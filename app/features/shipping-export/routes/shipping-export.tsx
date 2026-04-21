import {
  Alert,
  Box,
  Chip,
  Paper,
  Step,
  StepButton,
  Stepper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { data, Link, type MetaFunction, useLoaderData } from "react-router";
import Papa from "papaparse";
import { useEffect, useState } from "react";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import { loadPullSheetItemsFromCsvText } from "~/features/pull-sheet/utils/pullSheetItems";
import { getEasyPostEnvironmentStatus } from "../config/easyPostConfig.server";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import {
  buildShippingWorkflowOrderState,
  buildOrderNumbersInShipmentOrder,
  buildTimestampedFileName,
  createReturnShipment,
  getAllLabelSizes,
  getOrderNumbersForShipmentReference,
  getShipmentCsvRows,
  getShipmentsForLabelSize,
  mapOrderToShipment,
} from "../services/shippingExportUtils";
import {
  allocatePullSheetItemsToShipments,
  type PackPullSheetLoadStatus,
} from "../services/packPullSheet";
import {
  type EasyPostMode,
  type EasyPostShipment,
  type LabelSize,
  type ReturnFlowType,
  type ShipmentToOrderMap,
  type ShippingExportConfig,
  type ShippingLiveOrderLoadResponse,
  type ShippingPostageBatchLabelRequestItem,
  type ShippingPostageBatchLabelResult,
  type ShippingPostageDirection,
  type ShippingPostageLookupResponse,
  type ShippingPostagePurchaseResponse,
  type ShippingPostagePurchaseResult,
  type ShippingPostagePurchaseScope,
  type ShippingShippedMessageRequestItem,
  type ShippingShippedMessageResponse,
  type ShippingShippedMessageResult,
  type ShippingTrackingApplyRequestItem,
  type ShippingTrackingApplyResponse,
  type ShippingTrackingApplyResult,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";
import { ShipmentEditDrawer } from "../components/ShipmentEditDrawer";
import { LoadOrdersStep } from "../components/steps/LoadOrdersStep";
import { PullSheetStep } from "../components/steps/PullSheetStep";
import { BuyPostageStep } from "../components/steps/BuyPostageStep";
import { PrintStep } from "../components/steps/PrintStep";
import { PackStep } from "../components/steps/PackStep";
import { ApplyTrackingStep } from "../components/steps/ApplyTrackingStep";
import { NotifyStep } from "../components/steps/NotifyStep";
import { ReturnFlowPanel } from "../components/ReturnFlowPanel";

type PurchaseEntry = {
  mode: EasyPostMode;
  result: ShippingPostagePurchaseResult;
};

const OUTBOUND_STEPS = [
  { key: "load-orders", label: "Load Orders" },
  { key: "pull-sheet", label: "Pull Sheet" },
  { key: "buy-postage", label: "Buy Postage" },
  { key: "print", label: "Print" },
  { key: "pack", label: "Pack" },
  { key: "apply-tracking", label: "Apply Tracking" },
  { key: "notify", label: "Notify" },
] as const;

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

    for (const orderNumber of shipmentToOrderMap[shipment.reference] ?? [shipment.reference]) {
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

    for (const orderNumber of shipmentToOrderMap[shipment.reference] ?? [shipment.reference]) {
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
  sourceOrders: TcgPlayerShippingOrder[];
  orders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  shipmentToOrderMap: ShipmentToOrderMap;
  shipmentReferences: string[];
  orderedOrderNumbers: string[];
} {
  return buildShippingWorkflowOrderState(sourceOrders, config);
}

function downloadCsvFile(filenamePrefix: string, shipments: EasyPostShipment[]): void {
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

async function fetchShippingExportPullSheetCsv(
  orderNumbers: string[],
): Promise<string> {
  const response = await fetch("/api/shipping-export/pull-sheet-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderNumbers,
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
      // Ignore non-JSON failures and use the default message.
    }

    throw new Error(message);
  }

  return response.text();
}

export const meta: MetaFunction = () => {
  return [
    { title: "Shipping Workflow" },
    {
      name: "description",
      content:
        "Step-by-step shipping workflow: load orders, pull cards, buy postage, print labels, pack, apply tracking, and notify buyers.",
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

  // ── Workflow navigation ───────────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState(0);
  const [activeTab, setActiveTab] = useState<"outbound" | "return">("outbound");

  // ── Order / shipment state ────────────────────────────────────────────────
  const [sourceOrders, setSourceOrders] = useState<TcgPlayerShippingOrder[]>([]);
  const [orders, setOrders] = useState<TcgPlayerShippingOrder[]>([]);
  const [shipments, setShipments] = useState<EasyPostShipment[]>([]);
  const [shipmentToOrderMap, setShipmentToOrderMap] = useState<ShipmentToOrderMap>({});
  const [shipmentReferences, setShipmentReferences] = useState<string[]>([]);

  // ── Input controls ────────────────────────────────────────────────────────
  const [sellerKeyInput, setSellerKeyInput] = useState(config.defaultSellerKey);
  const [singleOrderNumberInput, setSingleOrderNumberInput] = useState("");
  const [loadedSourceLabel, setLoadedSourceLabel] = useState("");
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ── Shipment edit drawer ──────────────────────────────────────────────────
  const [selectedShipment, setSelectedShipment] = useState<EasyPostShipment | null>(null);
  const [selectedShipmentReference, setSelectedShipmentReference] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ── Postage state ─────────────────────────────────────────────────────────
  const [outboundPurchaseResultsByReference, setOutboundPurchaseResultsByReference] =
    useState<Record<string, PurchaseEntry>>({});
  const [returnPurchaseResultsByReference, setReturnPurchaseResultsByReference] =
    useState<Record<string, PurchaseEntry>>({});
  const [batchLabelResultsBySize, setBatchLabelResultsBySize] = useState<
    Partial<Record<LabelSize, ShippingPostageBatchLabelResult>>
  >({});

  // ── Loading flags ─────────────────────────────────────────────────────────
  const [isLoadingExistingPostage, setIsLoadingExistingPostage] = useState(false);
  const [isLoadingLiveOrders, setIsLoadingLiveOrders] = useState(false);
  const [isLoadingSingleOrder, setIsLoadingSingleOrder] = useState(false);
  const [isGeneratingPullSheet, setIsGeneratingPullSheet] = useState(false);
  const [pullSheetItems, setPullSheetItems] = useState<PullSheetItem[]>([]);
  const [pullSheetOrderIds, setPullSheetOrderIds] = useState<string[]>([]);
  const [pullSheetError, setPullSheetError] = useState<string | null>(null);
  const [packingSlipAction, setPackingSlipAction] = useState<"download" | "open" | null>(null);
  const [generatingBatchLabelSize, setGeneratingBatchLabelSize] = useState<LabelSize | null>(null);
  const [purchasingLabelSize, setPurchasingLabelSize] = useState<LabelSize | null>(null);
  const [purchasingActionKey, setPurchasingActionKey] = useState<string | null>(null);
  const [isApplyingTracking, setIsApplyingTracking] = useState(false);
  const [trackingApplyResults, setTrackingApplyResults] = useState<ShippingTrackingApplyResult[]>([]);
  const [isSendingShippedMessages, setIsSendingShippedMessages] = useState(false);
  const [shippedMessageResults, setShippedMessageResults] = useState<ShippingShippedMessageResult[]>([]);

  // ── Pack step state ───────────────────────────────────────────────────────
  const [packedOrderNumbers, setPackedOrderNumbers] = useState<Set<string>>(new Set());
  const [packPullSheetStatus, setPackPullSheetStatus] =
    useState<PackPullSheetLoadStatus>("idle");
  const [packPullSheetError, setPackPullSheetError] = useState<string | null>(null);
  const [packPullSheetMatchesByReference, setPackPullSheetMatchesByReference] =
    useState<ReturnType<typeof allocatePullSheetItemsToShipments>>({});

  // ── Return flow state ─────────────────────────────────────────────────────
  const [returnFlowType, setReturnFlowType] = useState<ReturnFlowType>("round-trip");
  const [returnOrder, setReturnOrder] = useState<TcgPlayerShippingOrder | null>(null);
  const [returnShipment, setReturnShipment] = useState<EasyPostShipment | null>(null);
  const [isLoadingReturnOrder, setIsLoadingReturnOrder] = useState(false);
  const [isPurchasingReturn, setIsPurchasingReturn] = useState(false);
  const [outboundReturnPurchaseEntry, setOutboundReturnPurchaseEntry] = useState<PurchaseEntry | null>(null);
  const [returnOnlyPurchaseEntry, setReturnOnlyPurchaseEntry] = useState<PurchaseEntry | null>(null);

  // ── Derived values ────────────────────────────────────────────────────────
  const availableLabelSizes = getAllLabelSizes().filter((labelSize) =>
    shipments.some((shipment) => shipment.options.label_size === labelSize),
  );
  const orderedWorkflowOrderNumbers = buildOrderNumbersInShipmentOrder(
    shipmentReferences,
    shipmentToOrderMap,
  );
  const shipmentReferencesKey = shipmentReferences.join("|");
  const orderedWorkflowOrderNumbersKey = orderedWorkflowOrderNumbers.join("|");
  const hasPackPullSheetSourceData = sourceOrders.some(
    (order) => (order.products?.length ?? 0) > 0,
  );
  const trackingApplyItems = buildTrackingApplyItems(shipments, shipmentToOrderMap, outboundPurchaseResultsByReference);
  const shippedMessageItems = buildShippedMessageItems(
    shipments,
    sellerKeyInput,
    shipmentToOrderMap,
    outboundPurchaseResultsByReference,
  );

  // ── Internal helpers ──────────────────────────────────────────────────────
  const getOrderNumbersForShipment = (shipmentReference: string) =>
    getOrderNumbersForShipmentReference(shipmentToOrderMap, shipmentReference);

  const mergePurchaseResults = (
    previousResults: Record<string, PurchaseEntry>,
    mode: EasyPostMode,
    results: ShippingPostagePurchaseResult[],
  ) => {
    const nextResults = { ...previousResults };

    for (const result of results) {
      const previousResult = previousResults[result.reference];

      if (previousResult?.result.status === "purchased" && result.status === "skipped") {
        continue;
      }

      nextResults[result.reference] = { mode, result };
    }

    return nextResults;
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
          purchaseEntry: PurchaseEntry;
        } =>
          Boolean(
            entry.purchaseEntry &&
              entry.purchaseEntry.result.status !== "failed" &&
              entry.purchaseEntry.result.easypostShipmentId,
          ),
      );

  const loadExistingPostage = async (
    nextShipments: EasyPostShipment[],
    nextShipmentToOrderMap: ShipmentToOrderMap,
  ) => {
    setOutboundPurchaseResultsByReference({});
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipments: nextShipments.map((shipment) => ({
            shipmentReference: shipment.reference,
            orderNumbers: nextShipmentToOrderMap[shipment.reference] ?? [shipment.reference],
          })),
        }),
      });

      const payload = (await response.json()) as ShippingPostageLookupResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to load saved postage." : "Failed to load saved postage.");
      }

      const lookupResponse = payload as ShippingPostageLookupResponse;

      setOutboundPurchaseResultsByReference(
        Object.fromEntries(
          lookupResponse.results.map((entry) => [
            entry.shipmentReference,
            { mode: entry.mode, result: entry.result },
          ]),
        ),
      );
    } catch (lookupError) {
      console.error("Failed to load saved postage labels", lookupError);
      setOutboundPurchaseResultsByReference({});
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

    setSourceOrders(nextState.sourceOrders);
    setOrders(nextState.orders);
    setShipments(nextState.shipments);
    setShipmentToOrderMap(nextState.shipmentToOrderMap);
    setShipmentReferences(nextState.shipmentReferences);
    setLoadedSourceLabel(nextSourceLabel);
    setLoadWarnings(nextWarnings);
    setBatchLabelResultsBySize({});
    setTrackingApplyResults([]);
    setShippedMessageResults([]);
    setPackedOrderNumbers(new Set());
    setIsGeneratingPullSheet(false);
    setPullSheetItems([]);
    setPullSheetOrderIds([]);
    setPullSheetError(null);
    setPackPullSheetStatus("idle");
    setPackPullSheetError(null);
    setPackPullSheetMatchesByReference({});
    setError(null);
    await loadExistingPostage(nextState.shipments, nextState.shipmentToOrderMap);
  };

  // ── Handlers: load orders ─────────────────────────────────────────────────
  useEffect(() => {
    let isActive = true;

    if (orderedWorkflowOrderNumbers.length === 0) {
      setIsGeneratingPullSheet(false);
      setPullSheetItems([]);
      setPullSheetOrderIds([]);
      setPullSheetError(null);
      setPackPullSheetStatus("idle");
      setPackPullSheetError(null);
      setPackPullSheetMatchesByReference({});

      return () => {
        isActive = false;
      };
    }

    const loadPullSheet = async () => {
      setIsGeneratingPullSheet(true);
      setPullSheetItems([]);
      setPullSheetOrderIds([]);
      setPullSheetError(null);

      if (hasPackPullSheetSourceData) {
        setPackPullSheetStatus("loading");
      } else {
        setPackPullSheetStatus("idle");
      }
      setPackPullSheetError(null);
      setPackPullSheetMatchesByReference({});

      try {
        const csvText = await fetchShippingExportPullSheetCsv(
          orderedWorkflowOrderNumbers,
        );
        const result = await loadPullSheetItemsFromCsvText(csvText);

        if (!isActive) {
          return;
        }

        setPullSheetItems(result.items);
        setPullSheetOrderIds(result.orderIds);

        if (hasPackPullSheetSourceData) {
          const matches = allocatePullSheetItemsToShipments(
            shipmentReferences,
            sourceOrders,
            shipmentToOrderMap,
            result.items,
          );

          setPackPullSheetMatchesByReference(matches);
          setPackPullSheetStatus("ready");
        }
      } catch (pullSheetLoadError) {
        if (!isActive) {
          return;
        }

        const nextError = String(pullSheetLoadError);
        setPullSheetItems([]);
        setPullSheetOrderIds([]);
        setPullSheetError(nextError);

        if (hasPackPullSheetSourceData) {
          setPackPullSheetStatus("error");
          setPackPullSheetError(nextError);
          setPackPullSheetMatchesByReference({});
        }
      } finally {
        if (isActive) {
          setIsGeneratingPullSheet(false);
        }
      }
    };

    void loadPullSheet();

    return () => {
      isActive = false;
    };
  }, [
    hasPackPullSheetSourceData,
    orderedWorkflowOrderNumbersKey,
    shipmentReferencesKey,
    shipmentToOrderMap,
    sourceOrders,
  ]);

  const handleLoadLiveOrders = async () => {
    setIsLoadingLiveOrders(true);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerKey: sellerKeyInput.trim() }),
      });

      const payload = (await response.json()) as ShippingLiveOrderLoadResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to load live seller orders." : "Failed to load live seller orders.");
      }

      const liveOrderResponse = payload as ShippingLiveOrderLoadResponse;

      setSellerKeyInput(liveOrderResponse.sellerKey);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerKey: sellerKeyInput.trim(),
          orderNumber: normalizedOrderNumber,
        }),
      });

      const payload = (await response.json()) as ShippingLiveOrderLoadResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to load the requested TCGPlayer order." : "Failed to load the requested TCGPlayer order.");
      }

      const singleOrderResponse = payload as ShippingLiveOrderLoadResponse;

      if (singleOrderResponse.sellerKey) {
        setSellerKeyInput(singleOrderResponse.sellerKey);
      }

      setSingleOrderNumberInput(singleOrderResponse.loadedOrderNumbers[0] ?? normalizedOrderNumber);
      await applyOrderSource(
        singleOrderResponse.orders,
        `Single TCGPlayer order: ${singleOrderResponse.loadedOrderNumbers[0] ?? normalizedOrderNumber}`,
        singleOrderResponse.warnings ?? [],
      );
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setIsLoadingSingleOrder(false);
    }
  };

  // ── Handlers: pull sheet & packing slips ──────────────────────────────────
  const handlePackingSlipExport = async (action: "download" | "open") => {
    if (orderedWorkflowOrderNumbers.length === 0 || packingSlipAction !== null) {
      return;
    }

    const packingSlipWindow = action === "open" ? window.open("about:blank", "_blank") : null;

    setPackingSlipAction(action);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/packing-slips-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderNumbers: orderedWorkflowOrderNumbers,
          timezoneOffset: -new Date().getTimezoneOffset() / 60,
        }),
      });

      if (!response.ok) {
        let message = "Failed to generate packing slips export.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch { /* ignore */ }
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

  // ── Handlers: shipment edit ───────────────────────────────────────────────
  const handleOpenEditDrawer = (shipment: EasyPostShipment) => {
    setSelectedShipment(shipment);
    setSelectedShipmentReference(shipment.reference);
    setDrawerOpen(true);
  };

  const handleSaveShipmentChanges = () => {
    if (!selectedShipment || !selectedShipmentReference) {
      return;
    }

    setShipments((prev) =>
      prev.map((s) => (s.reference === selectedShipmentReference ? selectedShipment : s)),
    );
    setDrawerOpen(false);
    setSelectedShipmentReference(selectedShipment.reference);
  };

  const handleDownloadShipment = (shipment: EasyPostShipment) => {
    downloadCsvFile(`EasyPost_Shipments_${shipment.options.label_size}`, [shipment]);
  };

  const handleDownloadReturnShipment = (shipment: EasyPostShipment) => {
    const returnShipmentData = createReturnShipment(shipment);
    downloadCsvFile(`EasyPost_Returns_${returnShipmentData.options.label_size}`, [returnShipmentData]);
  };

  // ── Handlers: postage purchase ────────────────────────────────────────────
  const purchaseShipments = async ({
    labelSize,
    shipmentItems,
    direction,
    purchaseScope,
  }: {
    labelSize: LabelSize;
    shipmentItems: Array<{ shipment: EasyPostShipment; orderNumbers: string[] }>;
    direction: ShippingPostageDirection;
    purchaseScope: ShippingPostagePurchaseScope;
  }) => {
    if (direction === "outbound") {
      setTrackingApplyResults([]);
    }

    const response = await fetch("/api/shipping-export/postages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelSize, direction, purchaseScope, shipments: shipmentItems }),
    });

    const payload = (await response.json()) as ShippingPostagePurchaseResponse | { error?: string };

    if (!response.ok) {
      throw new Error("error" in payload ? payload.error ?? "Failed to buy postage." : "Failed to buy postage.");
    }

    const purchaseResponse = payload as ShippingPostagePurchaseResponse;

    if (direction === "return") {
      setReturnPurchaseResultsByReference((prev) =>
        mergePurchaseResults(prev, purchaseResponse.mode, purchaseResponse.results),
      );
      return;
    }

    setOutboundPurchaseResultsByReference((prev) =>
      mergePurchaseResults(prev, purchaseResponse.mode, purchaseResponse.results),
    );

    if (purchaseScope === "bulk") {
      setBatchLabelResultsBySize((prev) => ({
        ...prev,
        [labelSize]: purchaseResponse.batchLabel,
      }));
    }
  };

  const purchasePostageForLabelSize = async (labelSize: LabelSize) => {
    const labelShipments = getShipmentsForLabelSize(shipments, labelSize);

    if (labelShipments.length === 0) return;

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

  const handleBuyPostage = async () => {
    if (availableLabelSizes.length === 0 || purchasingLabelSize || purchasingActionKey) {
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
    if (purchasingLabelSize || purchasingActionKey) return;

    setPurchasingActionKey(`outbound:${shipment.reference}`);
    setError(null);

    try {
      await purchaseShipments({
        labelSize: shipment.options.label_size,
        direction: "outbound",
        purchaseScope: "single",
        shipmentItems: [{ shipment, orderNumbers: getOrderNumbersForShipment(shipment.reference) }],
      });
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setPurchasingActionKey(null);
    }
  };

  const handleBuyReturnLabel = async (shipment: EasyPostShipment) => {
    if (purchasingLabelSize || purchasingActionKey) return;

    setPurchasingActionKey(`return:${shipment.reference}`);
    setError(null);

    try {
      const returnShipmentData = createReturnShipment(shipment);
      await purchaseShipments({
        labelSize: returnShipmentData.options.label_size,
        direction: "return",
        purchaseScope: "single",
        shipmentItems: [{ shipment: returnShipmentData, orderNumbers: getOrderNumbersForShipment(shipment.reference) }],
      });
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setPurchasingActionKey(null);
    }
  };

  const handleGenerateBatchLabelFromSavedPostage = async (labelSize: LabelSize) => {
    const savedEntries = getSavedPurchasedEntriesForLabelSize(labelSize);

    if (savedEntries.length === 0 || generatingBatchLabelSize) return;

    const uniqueModes = [...new Set(savedEntries.map((entry) => entry.purchaseEntry.mode))];

    if (uniqueModes.length !== 1) {
      setBatchLabelResultsBySize((prev) => ({
        ...prev,
        [labelSize]: {
          status: "failed",
          shipmentReferences: savedEntries.map((e) => e.shipment.reference),
          message: "Saved labels for this size span multiple EasyPost modes. Rebuy or regroup them to generate one batch PDF.",
        },
      }));
      return;
    }

    setGeneratingBatchLabelSize(labelSize);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/batch-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: uniqueModes[0],
          labelSize,
          shipments: savedEntries.map(
            (entry): ShippingPostageBatchLabelRequestItem => ({
              shipmentReference: entry.shipment.reference,
              easypostShipmentId: entry.purchaseEntry.result.easypostShipmentId!,
            }),
          ),
        }),
      });

      const payload = (await response.json()) as ShippingPostageBatchLabelResult | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to create the batch label PDF." : "Failed to create the batch label PDF.");
      }

      setBatchLabelResultsBySize((prev) => ({
        ...prev,
        [labelSize]: payload as ShippingPostageBatchLabelResult,
      }));
    } catch (generationError) {
      setError(String(generationError));
    } finally {
      setGeneratingBatchLabelSize(null);
    }
  };

  // ── Handlers: tracking & messaging ───────────────────────────────────────
  const handleApplyTracking = async () => {
    if (trackingApplyItems.length === 0 || isApplyingTracking) return;

    setIsApplyingTracking(true);
    setTrackingApplyResults([]);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: trackingApplyItems }),
      });

      const payload = (await response.json()) as ShippingTrackingApplyResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to apply tracking to TCGPlayer orders." : "Failed to apply tracking to TCGPlayer orders.");
      }

      setTrackingApplyResults((payload as ShippingTrackingApplyResponse).results);
    } catch (trackingError) {
      setError(String(trackingError));
    } finally {
      setIsApplyingTracking(false);
    }
  };

  const handleSendShippedMessages = async () => {
    if (shippedMessageItems.length === 0 || isSendingShippedMessages) return;

    setIsSendingShippedMessages(true);
    setShippedMessageResults([]);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-shipped-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: shippedMessageItems }),
      });

      const payload = (await response.json()) as ShippingShippedMessageResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to send shipped messages to TCGPlayer." : "Failed to send shipped messages to TCGPlayer.");
      }

      setShippedMessageResults((payload as ShippingShippedMessageResponse).results);
    } catch (shippedMessageError) {
      setError(String(shippedMessageError));
    } finally {
      setIsSendingShippedMessages(false);
    }
  };

  // ── Handler: pack step ────────────────────────────────────────────────────
  const handleOrderPacked = (reference: string, packed: boolean) => {
    setPackedOrderNumbers((prev) => {
      const next = new Set(prev);
      if (packed) {
        next.add(reference);
      } else {
        next.delete(reference);
      }
      return next;
    });
  };

  // ── Handler: return flow ──────────────────────────────────────────────────
  const handleLookupReturnOrder = async () => {
    const normalizedOrderNumber = singleOrderNumberInput.trim();

    if (!normalizedOrderNumber) return;

    setIsLoadingReturnOrder(true);
    setReturnOrder(null);
    setReturnShipment(null);
    setOutboundReturnPurchaseEntry(null);
    setReturnOnlyPurchaseEntry(null);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerKey: sellerKeyInput.trim(),
          orderNumber: normalizedOrderNumber,
        }),
      });

      const payload = (await response.json()) as ShippingLiveOrderLoadResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Failed to load order." : "Failed to load order.");
      }

      const singleOrderResponse = payload as ShippingLiveOrderLoadResponse;
      const loadedOrder = singleOrderResponse.orders[0] ?? null;

      setReturnOrder(loadedOrder);

      if (loadedOrder) {
        const shipmentForOrder = mapOrderToShipment(loadedOrder, config);
        setReturnShipment(shipmentForOrder);
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setIsLoadingReturnOrder(false);
    }
  };

  const handleBuyReturnFlowLabels = async () => {
    if (!returnShipment || isPurchasingReturn) return;

    setIsPurchasingReturn(true);
    setOutboundReturnPurchaseEntry(null);
    setReturnOnlyPurchaseEntry(null);
    setError(null);

    const orderNumbers = returnOrder ? [returnOrder["Order #"]] : [returnShipment.reference];

    try {
      if (returnFlowType === "round-trip") {
        // Outbound: seller → buyer (normal shipment direction)
        const outboundResponse = await fetch("/api/shipping-export/postages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            labelSize: returnShipment.options.label_size,
            direction: "outbound",
            purchaseScope: "single",
            shipments: [{ shipment: returnShipment, orderNumbers }],
          }),
        });

        const outboundPayload = (await outboundResponse.json()) as ShippingPostagePurchaseResponse | { error?: string };

        if (!outboundResponse.ok) {
          throw new Error("error" in outboundPayload ? outboundPayload.error ?? "Failed to buy outbound label." : "Failed to buy outbound label.");
        }

        const outboundResult = (outboundPayload as ShippingPostagePurchaseResponse).results[0];

        if (outboundResult) {
          setOutboundReturnPurchaseEntry({ mode: (outboundPayload as ShippingPostagePurchaseResponse).mode, result: outboundResult });
        }
      }

      // Return label: buyer → seller (swap addresses)
      const returnShipmentData = createReturnShipment(returnShipment);
      const returnResponse = await fetch("/api/shipping-export/postages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labelSize: returnShipmentData.options.label_size,
          direction: "return",
          purchaseScope: "single",
          shipments: [{ shipment: returnShipmentData, orderNumbers }],
        }),
      });

      const returnPayload = (await returnResponse.json()) as ShippingPostagePurchaseResponse | { error?: string };

      if (!returnResponse.ok) {
        throw new Error("error" in returnPayload ? returnPayload.error ?? "Failed to buy return label." : "Failed to buy return label.");
      }

      const returnResult = (returnPayload as ShippingPostagePurchaseResponse).results[0];

      if (returnResult) {
        setReturnOnlyPurchaseEntry({ mode: (returnPayload as ShippingPostagePurchaseResponse).mode, result: returnResult });
      }
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setIsPurchasingReturn(false);
    }
  };

  // ── Handler: reset workflow ───────────────────────────────────────────────
  const handleReset = () => {
    setCurrentStep(0);
    setSourceOrders([]);
    setOrders([]);
    setShipments([]);
    setShipmentToOrderMap({});
    setShipmentReferences([]);
    setOutboundPurchaseResultsByReference({});
    setReturnPurchaseResultsByReference({});
    setBatchLabelResultsBySize({});
    setTrackingApplyResults([]);
    setShippedMessageResults([]);
    setPackedOrderNumbers(new Set());
    setIsGeneratingPullSheet(false);
    setPullSheetItems([]);
    setPullSheetOrderIds([]);
    setPullSheetError(null);
    setPackPullSheetStatus("idle");
    setPackPullSheetError(null);
    setPackPullSheetMatchesByReference({});
    setLoadedSourceLabel("");
    setLoadWarnings([]);
    setError(null);
  };

  // ── Derived for mode status ───────────────────────────────────────────────
  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;

  return (
    <Box sx={{ maxWidth: 1400, mx: "auto", p: 3 }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ md: "center" }}
        sx={{ mb: 1 }}
      >
        <Box>
          <Typography variant="h4" component="h1" gutterBottom>
            Shipping Workflow
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Chip
              label={config.easypostMode === "test" ? "Test Mode" : "Production Mode"}
              color={config.easypostMode === "test" ? "warning" : "error"}
            />
            <Chip
              label={selectedModeHasApiKey ? "API Key Ready" : "Missing API Key"}
              color={selectedModeHasApiKey ? "success" : "warning"}
              variant={selectedModeHasApiKey ? "filled" : "outlined"}
            />
          </Stack>
        </Box>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Manage sender address, package thresholds, and label defaults in{" "}
        <Link to="/shipping-configuration" style={{ color: "inherit", fontWeight: 600 }}>
          Shipping Configuration
        </Link>
        .
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Tabs
        value={activeTab}
        onChange={(_, value: "outbound" | "return") => setActiveTab(value)}
        sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab label="Outbound Workflow" value="outbound" />
        <Tab label="Return Labels" value="return" />
      </Tabs>

      {activeTab === "outbound" && (
        <>
          <Stepper nonLinear activeStep={currentStep} sx={{ mb: 4 }}>
            {OUTBOUND_STEPS.map((step, index) => (
              <Step key={step.key} completed={index < currentStep}>
                <StepButton onClick={() => setCurrentStep(index)}>
                  {step.label}
                </StepButton>
              </Step>
            ))}
          </Stepper>

          <Paper sx={{ p: 3 }} elevation={2}>
            {currentStep === 0 && (
              <LoadOrdersStep
                config={config}
                sellerKeyInput={sellerKeyInput}
                singleOrderNumberInput={singleOrderNumberInput}
                sourceOrders={sourceOrders}
                loadedSourceLabel={loadedSourceLabel}
                isLoadingLiveOrders={isLoadingLiveOrders}
                isLoadingSingleOrder={isLoadingSingleOrder}
                isLoadingExistingPostage={isLoadingExistingPostage}
                loadWarnings={loadWarnings}
                onSellerKeyChange={setSellerKeyInput}
                onSingleOrderNumberChange={setSingleOrderNumberInput}
                onLoadLiveOrders={() => void handleLoadLiveOrders()}
                onLoadSingleOrder={() => void handleLoadSingleOrder()}
                onContinue={() => setCurrentStep(1)}
              />
            )}

            {currentStep === 1 && (
              <PullSheetStep
                sourceOrders={sourceOrders}
                shipments={shipments}
                pullSheetItems={pullSheetItems}
                pullSheetOrderIds={pullSheetOrderIds}
                isLoadingPullSheet={isGeneratingPullSheet}
                pullSheetError={pullSheetError}
                onBack={() => setCurrentStep(0)}
                onContinue={() => setCurrentStep(2)}
              />
            )}

            {currentStep === 2 && (
              <BuyPostageStep
                config={config}
                environmentStatus={environmentStatus}
                shipments={shipments}
                orders={orders}
                shipmentToOrderMap={shipmentToOrderMap}
                outboundPurchaseResultsByReference={outboundPurchaseResultsByReference}
                returnPurchaseResultsByReference={returnPurchaseResultsByReference}
                batchLabelResultsBySize={batchLabelResultsBySize}
                availableLabelSizes={availableLabelSizes}
                purchasingLabelSize={purchasingLabelSize}
                purchasingActionKey={purchasingActionKey}
                generatingBatchLabelSize={generatingBatchLabelSize}
                isLoadingExistingPostage={isLoadingExistingPostage}
                onBuyPostage={() => void handleBuyPostage()}
                onBuyShipment={(s) => void handleBuyShipment(s)}
                onBuyReturnLabel={(s) => void handleBuyReturnLabel(s)}
                onGenerateBatchLabel={(size) => void handleGenerateBatchLabelFromSavedPostage(size)}
                onEditShipment={handleOpenEditDrawer}
                onDownloadShipment={handleDownloadShipment}
                onDownloadReturnShipment={handleDownloadReturnShipment}
                savedPurchasedEntriesForLabelSize={getSavedPurchasedEntriesForLabelSize}
                onBack={() => setCurrentStep(1)}
                onContinue={() => setCurrentStep(3)}
              />
            )}

            {currentStep === 3 && (
              <PrintStep
                sourceOrders={sourceOrders}
                shipments={shipments}
                outboundPurchaseResultsByReference={outboundPurchaseResultsByReference}
                batchLabelResultsBySize={batchLabelResultsBySize}
                availableLabelSizes={availableLabelSizes}
                generatingBatchLabelSize={generatingBatchLabelSize}
                packingSlipAction={packingSlipAction}
                savedPurchasedEntriesForLabelSize={getSavedPurchasedEntriesForLabelSize}
                onOpenPackingSlips={() => void handlePackingSlipExport("open")}
                onDownloadPackingSlips={() => void handlePackingSlipExport("download")}
                onGenerateBatchLabel={(size) => void handleGenerateBatchLabelFromSavedPostage(size)}
                onBack={() => setCurrentStep(2)}
                onContinue={() => setCurrentStep(4)}
              />
            )}

            {currentStep === 4 && (
              <PackStep
                sourceOrders={sourceOrders}
                shipmentReferences={shipmentReferences}
                shipmentToOrderMap={shipmentToOrderMap}
                outboundPurchaseResultsByReference={outboundPurchaseResultsByReference}
                packPullSheetStatus={packPullSheetStatus}
                packPullSheetError={packPullSheetError}
                packPullSheetMatchesByReference={packPullSheetMatchesByReference}
                packedOrderNumbers={packedOrderNumbers}
                onOrderPacked={handleOrderPacked}
                onBack={() => setCurrentStep(3)}
                onContinue={() => setCurrentStep(5)}
              />
            )}

            {currentStep === 5 && (
              <ApplyTrackingStep
                trackingApplyItems={trackingApplyItems}
                trackingApplyResults={trackingApplyResults}
                isApplyingTracking={isApplyingTracking}
                onApplyTracking={() => void handleApplyTracking()}
                onBack={() => setCurrentStep(4)}
                onContinue={() => setCurrentStep(6)}
              />
            )}

            {currentStep === 6 && (
              <NotifyStep
                shippedMessageItems={shippedMessageItems}
                shippedMessageResults={shippedMessageResults}
                isSendingShippedMessages={isSendingShippedMessages}
                onSendShippedMessages={() => void handleSendShippedMessages()}
                onBack={() => setCurrentStep(5)}
                onReset={handleReset}
              />
            )}
          </Paper>
        </>
      )}

      {activeTab === "return" && (
        <Paper sx={{ p: 3 }} elevation={2}>
          <ReturnFlowPanel
            config={config}
            environmentStatus={environmentStatus}
            sellerKeyInput={sellerKeyInput}
            singleOrderNumberInput={singleOrderNumberInput}
            returnOrder={returnOrder}
            returnShipment={returnShipment}
            returnFlowType={returnFlowType}
            outboundReturnPurchaseEntry={outboundReturnPurchaseEntry}
            returnOnlyPurchaseEntry={returnOnlyPurchaseEntry}
            isLoadingReturnOrder={isLoadingReturnOrder}
            isPurchasingReturn={isPurchasingReturn}
            onOrderNumberChange={setSingleOrderNumberInput}
            onLookupOrder={() => void handleLookupReturnOrder()}
            onReturnFlowTypeChange={setReturnFlowType}
            onBuyLabels={() => void handleBuyReturnFlowLabels()}
          />
        </Paper>
      )}

      <ShipmentEditDrawer
        shipment={selectedShipment}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSave={handleSaveShipmentChanges}
        onChange={(changes) =>
          setSelectedShipment((prev) => (prev ? { ...prev, ...changes } : prev))
        }
      />
    </Box>
  );
}
