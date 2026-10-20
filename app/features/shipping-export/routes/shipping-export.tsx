import CloseIcon from "@mui/icons-material/Close";
import ReplyIcon from "@mui/icons-material/Reply";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  Alert,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Paper,
  Step,
  StepButton,
  Stepper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { data, Link, type MetaFunction, useLoaderData } from "react-router";
import Papa from "papaparse";
import { useEffect, useMemo, useRef, useState } from "react";
import { getEasyPostEnvironmentStatus } from "../config/easyPostConfig.server";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import {
  buildShippedMessageItems,
  buildShippingWorkflowOrderState,
  buildOrderNumbersInShipmentOrder,
  buildTimestampedFileName,
  buildTrackingApplyItems,
  mergeResultsByOrderNumber,
  createRoundTripShipments,
  createReturnShipment,
  getAllLabelSizes,
  getOrderNumbersForShipmentReference,
  getOrdersForShipmentReference,
  getShipmentCsvRows,
  getShipmentsForLabelSize,
  mapOrderToShipment,
} from "../services/shippingExportUtils";
import { useShippingPullSheet } from "../hooks/useShippingPullSheet";
import { readJsonResponse, readResponseError } from "~/core/utils/readJsonResponse";
import {
  type SavedShippingWorkflow,
  type SavedShippingWorkflowInput,
} from "../services/savedShippingWorkflow";
import { useSavedShippingWorkflow } from "../hooks/useSavedShippingWorkflow";
import {
  type EasyPostMode,
  type EasyPostService,
  type EasyPostShipment,
  type LabelSize,
  type ReturnFlowType,
  type ShipmentToOrderMap,
  type ShippingLiveOrderLoadResponse,
  type ShippingPostageBatchLabelRequestItem,
  type ShippingPostageBatchLabelResult,
  type ShippingPostageDirection,
  type ShippingPostageLookupResponse,
  type ShippingPostagePurchaseEntry,
  type ShippingPostagePurchaseResponse,
  type ShippingPostagePurchaseResult,
  type ShippingPostagePurchaseScope,
  type ShippingShippedMessageResponse,
  type ShippingShippedMessageResult,
  type ShippingTrackingApplyResponse,
  type ShippingTrackingApplyResult,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";
import { ShipmentEditDrawer } from "../components/ShipmentEditDrawer";
import { ShippingStepBar, type ShippingStepAction } from "../components/ShippingStepBar";
import { SaleValueFigures } from "../components/SaleValueFigures";
import { saleValueOfOrders } from "../services/saleValue";
import { describeShippingStep, OUTBOUND_STEPS } from "../services/shippingStepProgress";
import { LoadOrdersStep } from "../components/steps/LoadOrdersStep";
import { PullSheetStep } from "../components/steps/PullSheetStep";
import { BuyPostageStep } from "../components/steps/BuyPostageStep";
import { PrintStep } from "../components/steps/PrintStep";
import { PackStep } from "../components/steps/PackStep";
import { ShipStep } from "../components/steps/ShipStep";
import { ReturnFlowPanel } from "../components/ReturnFlowPanel";
import type { SellerOrderCoverage } from "~/features/seller-order-history/types/sellerOrderHistory";
import { refreshShippingIntakeHistory, withoutShippingIntakeHistory } from "../services/shippingIntakeHistory";

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

export const meta: MetaFunction = () => {
  return [
    { title: "Shipping Workflow" },
    {
      name: "description",
      content:
        "Step-by-step shipping workflow: load orders, pull cards, buy postage, print labels, pack, then mark orders shipped and notify buyers.",
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
  const [returnsOpen, setReturnsOpen] = useState(false);

  // ── Order / shipment state ────────────────────────────────────────────────
  const [sourceOrders, setSourceOrders] = useState<TcgPlayerShippingOrder[]>([]);
  const [shipments, setShipments] = useState<EasyPostShipment[]>([]);
  const [shipmentToOrderMap, setShipmentToOrderMap] = useState<ShipmentToOrderMap>({});
  const [shipmentReferences, setShipmentReferences] = useState<string[]>([]);

  // ── Input controls ────────────────────────────────────────────────────────
  const [sellerKeyInput, setSellerKeyInput] = useState(config.defaultSellerKey);
  const [singleOrderNumberInput, setSingleOrderNumberInput] = useState("");
  const [loadedSourceLabel, setLoadedSourceLabel] = useState("");
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyCoverage, setHistoryCoverage] = useState<SellerOrderCoverage>();
  const [isUpdatingHistory, setIsUpdatingHistory] = useState(false);

  // ── Shipment edit drawer ──────────────────────────────────────────────────
  const [selectedShipment, setSelectedShipment] = useState<EasyPostShipment | null>(null);
  const [selectedShipmentReference, setSelectedShipmentReference] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ── Postage state ─────────────────────────────────────────────────────────
  const [outboundPurchaseResultsByReference, setOutboundPurchaseResultsByReference] =
    useState<Record<string, ShippingPostagePurchaseEntry>>({});
  const [returnPurchaseResultsByReference, setReturnPurchaseResultsByReference] =
    useState<Record<string, ShippingPostagePurchaseEntry>>({});
  const [batchLabelResultsBySize, setBatchLabelResultsBySize] = useState<
    Partial<Record<LabelSize, ShippingPostageBatchLabelResult>>
  >({});

  // ── Loading flags ─────────────────────────────────────────────────────────
  const [isLoadingExistingPostage, setIsLoadingExistingPostage] = useState(false);
  const [isLoadingLiveOrders, setIsLoadingLiveOrders] = useState(false);
  const [isLoadingSingleOrder, setIsLoadingSingleOrder] = useState(false);
  const [packingSlipAction, setPackingSlipAction] = useState<"download" | "open" | null>(null);
  const [generatingBatchLabelSize, setGeneratingBatchLabelSize] = useState<LabelSize | null>(null);
  const [purchasingLabelSize, setPurchasingLabelSize] = useState<LabelSize | null>(null);
  const [purchasingActionKey, setPurchasingActionKey] = useState<string | null>(null);
  const [isShipping, setIsShipping] = useState(false);
  const [trackingApplyResults, setTrackingApplyResults] = useState<ShippingTrackingApplyResult[]>([]);
  const [shippedMessageResults, setShippedMessageResults] = useState<ShippingShippedMessageResult[]>([]);

  // ── Pack step state ───────────────────────────────────────────────────────
  const [packedOrderNumbers, setPackedOrderNumbers] = useState<Set<string>>(new Set());
  const [packShipmentIndex, setPackShipmentIndex] = useState(0);

  // ── Return flow state ─────────────────────────────────────────────────────
  const [returnOrderNumberInput, setReturnOrderNumberInput] = useState("");
  const [returnFlowType, setReturnFlowType] = useState<ReturnFlowType>("round-trip");
  const [returnService, setReturnService] = useState<EasyPostService>("First");
  const [returnOrder, setReturnOrder] = useState<TcgPlayerShippingOrder | null>(null);
  const [returnShipment, setReturnShipment] = useState<EasyPostShipment | null>(null);
  const [isLoadingReturnOrder, setIsLoadingReturnOrder] = useState(false);
  const [isLoadingReturnLabels, setIsLoadingReturnLabels] = useState(false);
  const [isPurchasingReturn, setIsPurchasingReturn] = useState(false);
  const [outboundReturnPurchaseEntry, setOutboundReturnPurchaseEntry] = useState<ShippingPostagePurchaseEntry | null>(null);
  const [returnOnlyPurchaseEntry, setReturnOnlyPurchaseEntry] = useState<ShippingPostagePurchaseEntry | null>(null);

  /** Only the newest postage lookup may write results, so a slow older one cannot overwrite them. */
  const postageLookupSequenceRef = useRef(0);
  /** Fences saved restore and remote loads so an older response cannot replace a newer order source. */
  const orderSourceSequenceRef = useRef(0);
  const intakeRefreshSequenceRef = useRef(0);
  const sourceOrdersRef = useRef(sourceOrders);
  sourceOrdersRef.current = sourceOrders;

  // ── Derived values ────────────────────────────────────────────────────────
  const availableLabelSizes = getAllLabelSizes().filter((labelSize) =>
    shipments.some((shipment) => shipment.options.label_size === labelSize),
  );
  const orderedWorkflowOrderNumbers = buildOrderNumbersInShipmentOrder(
    shipmentReferences,
    shipmentToOrderMap,
  );
  const sourceOrderNumbersKey = sourceOrders.map((order) => order["Order #"]).join("|");
  const {
    isGeneratingPullSheet,
    pullSheetItems,
    pullSheetError,
    packPullSheetStatus,
    packPullSheetError,
    packPullSheetMatchesByReference,
  } = useShippingPullSheet(
    orderedWorkflowOrderNumbers,
    sourceOrders,
    shipmentReferences,
    shipmentToOrderMap,
  );
  const { updates: trackingApplyItems, alreadyTrackedCount } = buildTrackingApplyItems(
    shipments,
    shipmentToOrderMap,
    outboundPurchaseResultsByReference,
    sourceOrders,
    trackingApplyResults,
  );
  const { messages: shippedMessageItems } = buildShippedMessageItems(
    shipments,
    sellerKeyInput,
    shipmentToOrderMap,
    outboundPurchaseResultsByReference,
    shippedMessageResults,
  );
  const shipPendingOrderNumbers = [
    ...new Set([...trackingApplyItems, ...shippedMessageItems].map((item) => item.orderNumber)),
  ];
  // Without a seller key no buyer can be messaged, so no order counts as shipped.
  const hasSellerKey = Boolean(sellerKeyInput.trim());
  const productionOrderCount = trackingApplyItems.length + alreadyTrackedCount;
  const shippedOrderCount = hasSellerKey
    ? Math.max(0, productionOrderCount - shipPendingOrderNumbers.length)
    : 0;
  const unshippedOrderCount = productionOrderCount - shippedOrderCount;

  // ── Internal helpers ──────────────────────────────────────────────────────
  const getOrderNumbersForShipment = (shipmentReference: string) =>
    getOrderNumbersForShipmentReference(shipmentToOrderMap, shipmentReference);

  const mergePurchaseResults = (
    previousResults: Record<string, ShippingPostagePurchaseEntry>,
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
          purchaseEntry: ShippingPostagePurchaseEntry;
        } =>
          Boolean(
            entry.purchaseEntry &&
              entry.purchaseEntry.result.status !== "failed" &&
              entry.purchaseEntry.result.easypostShipmentId,
          ),
      );

  /**
   * Looks up saved outbound postage for the shipments. Resolves to false when
   * a newer load superseded this one, in which case nothing was applied.
   */
  const loadExistingPostage = async (
    nextShipments: EasyPostShipment[],
    nextShipmentToOrderMap: ShipmentToOrderMap,
  ): Promise<boolean> => {
    const lookupSequence = ++postageLookupSequenceRef.current;
    setIsLoadingExistingPostage(nextShipments.length > 0);

    if (nextShipments.length === 0) {
      return true;
    }

    let purchaseEntriesByReference: Record<string, ShippingPostagePurchaseEntry> | null = null;
    let lookupError: unknown = null;

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

      const lookupResponse = await readJsonResponse<ShippingPostageLookupResponse>(
        response,
        "Failed to load saved postage.",
      );

      purchaseEntriesByReference = Object.fromEntries(
        lookupResponse.results.map((entry) => [
          entry.shipmentReference,
          { mode: entry.mode, result: entry.result },
        ]),
      );
    } catch (caughtError) {
      lookupError = caughtError;
    }

    if (lookupSequence !== postageLookupSequenceRef.current) {
      return false;
    }

    setIsLoadingExistingPostage(false);

    if (purchaseEntriesByReference) {
      setOutboundPurchaseResultsByReference(purchaseEntriesByReference);
    } else {
      setError(String(lookupError));
    }

    return true;
  };

  /**
   * Replaces the loaded orders, clears all downstream progress, and starts the
   * postage lookup for them. Resolves when that lookup has finished, to false
   * if a newer load superseded it.
   */
  const applyOrderSource = (
    nextSourceOrders: TcgPlayerShippingOrder[],
    nextSourceLabel: string,
    nextWarnings: string[] = [],
    expectedSequence?: number,
  ): Promise<boolean> => {
    if (expectedSequence !== undefined && expectedSequence !== orderSourceSequenceRef.current) return Promise.resolve(false);
    if (expectedSequence === undefined) orderSourceSequenceRef.current += 1;
    intakeRefreshSequenceRef.current += 1;
    const nextState = buildShippingWorkflowOrderState(nextSourceOrders, config);

    setSourceOrders(nextState.sourceOrders);
    setShipments(nextState.shipments);
    setShipmentToOrderMap(nextState.shipmentToOrderMap);
    setShipmentReferences(nextState.shipmentReferences);
    setLoadedSourceLabel(nextSourceLabel);
    setLoadWarnings(nextWarnings);
    setOutboundPurchaseResultsByReference({});
    setReturnPurchaseResultsByReference({});
    setBatchLabelResultsBySize({});
    setTrackingApplyResults([]);
    setShippedMessageResults([]);
    setPackedOrderNumbers(new Set());
    setPackShipmentIndex(0);
    setError(null);
    return loadExistingPostage(nextState.shipments, nextState.shipmentToOrderMap);
  };

  // ── Saved workflow ────────────────────────────────────────────────────────
  const savedWorkflowInput = useMemo<SavedShippingWorkflowInput>(
    () => ({
      currentStep,
      sellerKey: sellerKeyInput,
      loadedSourceLabel,
      loadWarnings,
      sourceOrders,
      returnPurchaseResultsByReference,
      packedOrderNumbers: [...packedOrderNumbers],
      trackingApplyResults,
      shippedMessageResults,
    }),
    [
      currentStep,
      sellerKeyInput,
      loadedSourceLabel,
      loadWarnings,
      sourceOrders,
      returnPurchaseResultsByReference,
      packedOrderNumbers,
      trackingApplyResults,
      shippedMessageResults,
    ],
  );

  const restoreSavedWorkflow = async (saved: SavedShippingWorkflow) => {
    const restoreSequence = ++orderSourceSequenceRef.current;
    if (saved.sellerKey) {
      setSellerKeyInput(saved.sellerKey);
    }

    let restoredOrders = withoutShippingIntakeHistory(saved.sourceOrders);
    const restoredWarnings = [...saved.loadWarnings];
    const refreshSequence = ++intakeRefreshSequenceRef.current;
    try {
      const configuredSeller = config.defaultSellerKey.trim();
      if (!configuredSeller || saved.sellerKey.trim() !== configuredSeller) {
        throw new Error("The saved workflow seller does not match Shipping Configuration.");
      }
      restoredOrders = await refreshShippingIntakeHistory(saved.sourceOrders, configuredSeller);
      if (refreshSequence !== intakeRefreshSequenceRef.current) throw new Error("A newer intake history refresh replaced this one.");
    } catch (historyError) {
      restoredWarnings.push(`Saved intake history was cleared because it could not be refreshed: ${String(historyError)}`);
    }
    if (restoreSequence !== orderSourceSequenceRef.current) {
      throw new Error("A newer order load replaced the saved workflow.");
    }

    // Waits for the postage lookup so labels are present, or its failure shown,
    // before the saved step renders.
    const isCurrent = await applyOrderSource(
      restoredOrders,
      saved.loadedSourceLabel,
      restoredWarnings,
      restoreSequence,
    );

    if (!isCurrent) {
      throw new Error("The workflow was replaced before the saved one finished restoring.");
    }

    setCurrentStep(Math.min(Math.max(saved.currentStep, 0), OUTBOUND_STEPS.length - 1));
    setReturnPurchaseResultsByReference(saved.returnPurchaseResultsByReference);
    setPackedOrderNumbers(new Set(saved.packedOrderNumbers));
    setTrackingApplyResults(saved.trackingApplyResults);
    setShippedMessageResults(saved.shippedMessageResults);
  };

  const { restoredWorkflow, dismissRestoredWorkflow } = useSavedShippingWorkflow({
    input: savedWorkflowInput,
    onRestore: restoreSavedWorkflow,
  });

  useEffect(() => {
    if (!sourceOrders.length) return;
    const refresh = async () => {
      const sourceSnapshot = sourceOrdersRef.current;
      const expectedOrders = sourceSnapshot.map((order) => order["Order #"]).join("|");
      const expectedSequence = orderSourceSequenceRef.current;
      const refreshSequence = ++intakeRefreshSequenceRef.current;
      try {
        const refreshed = await refreshShippingIntakeHistory(sourceSnapshot, sellerKeyInput.trim());
        if (expectedSequence !== orderSourceSequenceRef.current || refreshSequence !== intakeRefreshSequenceRef.current) return;
        setSourceOrders((current) => current.map((order) => order["Order #"]).join("|") === expectedOrders ? refreshed : current);
      } catch (refreshError) {
        if (expectedSequence !== orderSourceSequenceRef.current || refreshSequence !== intakeRefreshSequenceRef.current) return;
        setSourceOrders((current) => current.map((order) => order["Order #"]).join("|") === expectedOrders
          ? withoutShippingIntakeHistory(current) : current);
        const warning = `Intake history refresh failed: ${String(refreshError)}`;
        setLoadWarnings((current) => current.includes(warning) ? current : [...current, warning]);
      }
    };
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void refresh(), 5 * 60_000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(interval); };
  }, [sellerKeyInput, sourceOrderNumbersKey]);

  // ── Handlers: load orders ─────────────────────────────────────────────────
  const handleLoadLiveOrders = async () => {
    const loadSequence = ++orderSourceSequenceRef.current;
    setIsLoadingLiveOrders(true);
    setError(null);

    try {
      const response = await fetch("/api/shipping-export/tcgplayer-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerKey: sellerKeyInput.trim() }),
      });

      const liveOrderResponse = await readJsonResponse<ShippingLiveOrderLoadResponse>(
        response,
        "Failed to load live seller orders.",
      );
      if (loadSequence !== orderSourceSequenceRef.current) return;

      setSellerKeyInput(liveOrderResponse.sellerKey);
      setHistoryCoverage(liveOrderResponse.historyCoverage);
      void applyOrderSource(
        liveOrderResponse.orders,
        `Live seller orders: ${liveOrderResponse.sellerKey}`,
        liveOrderResponse.warnings ?? [],
        loadSequence,
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

    const loadSequence = ++orderSourceSequenceRef.current;
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

      const singleOrderResponse = await readJsonResponse<ShippingLiveOrderLoadResponse>(
        response,
        "Failed to load the requested TCGPlayer order.",
      );
      if (loadSequence !== orderSourceSequenceRef.current) return;

      if (singleOrderResponse.sellerKey) {
        setSellerKeyInput(singleOrderResponse.sellerKey);
      }
      setHistoryCoverage(singleOrderResponse.historyCoverage);

      setSingleOrderNumberInput(singleOrderResponse.loadedOrderNumbers[0] ?? normalizedOrderNumber);
      void applyOrderSource(
        singleOrderResponse.orders,
        `Single TCGPlayer order: ${singleOrderResponse.loadedOrderNumbers[0] ?? normalizedOrderNumber}`,
        singleOrderResponse.warnings ?? [],
        loadSequence,
      );
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setIsLoadingSingleOrder(false);
    }
  };

  const updateSellerOrderHistory = async (
    payload: { action: "catch_up"; orderNumbers: string[] } | { action: "import_csv"; csvText: string; fileName: string },
  ) => {
    const sourceSequence = orderSourceSequenceRef.current;
    const refreshSequence = ++intakeRefreshSequenceRef.current;
    setIsUpdatingHistory(true);
    setError(null);
    try {
      const response = await fetch("/api/seller-order-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerKey: sellerKeyInput.trim(), ...payload }),
      });
      const result = await readJsonResponse<{ coverage: SellerOrderCoverage }>(
        response,
        "Failed to update seller order history.",
      );
      setHistoryCoverage(result.coverage);
      if (sourceOrders.length && sourceSequence === orderSourceSequenceRef.current) {
        try {
          const refreshed = await refreshShippingIntakeHistory(sourceOrders, sellerKeyInput.trim());
          if (sourceSequence !== orderSourceSequenceRef.current || refreshSequence !== intakeRefreshSequenceRef.current) return;
          setSourceOrders(refreshed);
        } catch (refreshError) {
          if (sourceSequence !== orderSourceSequenceRef.current || refreshSequence !== intakeRefreshSequenceRef.current) return;
          setSourceOrders((current) => withoutShippingIntakeHistory(current));
          setLoadWarnings((current) => [...current, `Intake history is unavailable after catch-up: ${String(refreshError)}`]);
        }
      }
    } catch (historyError) {
      setError(String(historyError));
    } finally {
      setIsUpdatingHistory(false);
    }
  };

  const handleImportHistoryFile = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setError("Seller order CSV exceeds the 5 MB limit.");
      return;
    }
    const csvText = await file.text();
    await updateSellerOrderHistory({ action: "import_csv", csvText, fileName: file.name });
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
        throw new Error(
          await readResponseError(response, "Failed to generate packing slips export."),
        );
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
    const response = await fetch("/api/shipping-export/postages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelSize, direction, purchaseScope, shipments: shipmentItems }),
    });

    const purchaseResponse = await readJsonResponse<ShippingPostagePurchaseResponse>(
      response,
      "Failed to buy postage.",
    );

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

      const batchLabelResult = await readJsonResponse<ShippingPostageBatchLabelResult>(
        response,
        "Failed to create the batch label PDF.",
      );

      setBatchLabelResultsBySize((prev) => ({
        ...prev,
        [labelSize]: batchLabelResult,
      }));
    } catch (generationError) {
      setError(String(generationError));
    } finally {
      setGeneratingBatchLabelSize(null);
    }
  };

  // ── Handlers: tracking & messaging ───────────────────────────────────────
  /**
   * Applies tracking to orders that still need it, then messages buyers. An
   * order whose tracking did not apply is not messaged, so no buyer hears it
   * shipped before TCGPlayer shows the tracking number.
   */
  const handleShip = async () => {
    if (shipPendingOrderNumbers.length === 0 || isShipping || !hasSellerKey) return;

    setIsShipping(true);
    setError(null);

    try {
      const untrackedOrderNumbers = new Set(trackingApplyItems.map((item) => item.orderNumber));

      if (trackingApplyItems.length > 0) {
        const response = await fetch("/api/shipping-export/tcgplayer-tracking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: trackingApplyItems }),
        });
        const trackingResponse = await readJsonResponse<ShippingTrackingApplyResponse>(
          response,
          "Failed to apply tracking to TCGPlayer orders.",
        );

        // Earlier applied orders stay applied when only the failed ones are retried.
        setTrackingApplyResults((previous) =>
          mergeResultsByOrderNumber(previous, trackingResponse.results),
        );
        for (const result of trackingResponse.results) {
          if (result.status === "applied") untrackedOrderNumbers.delete(result.orderNumber);
        }
      }

      const messages = shippedMessageItems.filter((item) => !untrackedOrderNumbers.has(item.orderNumber));
      if (messages.length > 0) {
        const response = await fetch("/api/shipping-export/tcgplayer-shipped-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
        });
        const shippedMessageResponse = await readJsonResponse<ShippingShippedMessageResponse>(
          response,
          "Failed to send shipped messages to TCGPlayer.",
        );

        // Earlier messaged orders stay messaged when only the failed ones are retried.
        setShippedMessageResults((previous) =>
          mergeResultsByOrderNumber(previous, shippedMessageResponse.results),
        );
      }
    } catch (shipError) {
      setError(String(shipError));
    } finally {
      setIsShipping(false);
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
  const lookupSavedPostageForOrder = async (
    direction: ShippingPostageDirection,
    orderNumber: string,
  ): Promise<ShippingPostagePurchaseEntry | null> => {
    const response = await fetch("/api/shipping-export/postage-lookups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction,
        shipments: [{ shipmentReference: orderNumber, orderNumbers: [orderNumber] }],
      }),
    });

    const lookupResponse = await readJsonResponse<ShippingPostageLookupResponse>(
      response,
      `Failed to load saved ${direction} postage.`,
    );
    const entry = lookupResponse.results[0];

    return entry
      ? { mode: entry.mode, result: entry.result, purchasedAt: entry.purchasedAt }
      : null;
  };

  const loadSavedReturnFlowLabels = async (orderNumber: string) => {
    setIsLoadingReturnLabels(true);

    try {
      const [savedOutbound, savedReturn] = await Promise.all([
        lookupSavedPostageForOrder("outbound", orderNumber),
        lookupSavedPostageForOrder("return", orderNumber),
      ]);

      setOutboundReturnPurchaseEntry(savedOutbound);
      setReturnOnlyPurchaseEntry(savedReturn);
    } catch (lookupError) {
      setError(String(lookupError));
    } finally {
      setIsLoadingReturnLabels(false);
    }
  };

  const handleLookupReturnOrder = async () => {
    const normalizedOrderNumber = returnOrderNumberInput.trim();

    if (!normalizedOrderNumber) return;

    setIsLoadingReturnOrder(true);
    setReturnOrder(null);
    setReturnShipment(null);
    setReturnService("First");
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

      const singleOrderResponse = await readJsonResponse<ShippingLiveOrderLoadResponse>(
        response,
        "Failed to load order.",
      );
      const loadedOrder = singleOrderResponse.orders[0] ?? null;

      setReturnOrder(loadedOrder);

      if (loadedOrder) {
        const shipmentForOrder = mapOrderToShipment(loadedOrder, config);
        setReturnShipment(shipmentForOrder);
        await loadSavedReturnFlowLabels(loadedOrder["Order #"]);
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
    setError(null);

    const orderNumbers = returnOrder ? [returnOrder["Order #"]] : [returnShipment.reference];
    const roundTripShipments = createRoundTripShipments(
      returnShipment,
      returnService,
      config,
      returnOrder,
    );

    try {
      if (returnFlowType === "round-trip") {
        // Outbound: seller → buyer (normal shipment direction)
        const outboundResponse = await fetch("/api/shipping-export/postages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            labelSize: roundTripShipments.outboundShipment.options.label_size,
            direction: "outbound",
            purchaseScope: "single",
            shipments: [{ shipment: roundTripShipments.outboundShipment, orderNumbers }],
          }),
        });

        const outboundPayload = await readJsonResponse<ShippingPostagePurchaseResponse>(
          outboundResponse,
          "Failed to buy outbound label.",
        );
        const outboundResult = outboundPayload.results[0];

        if (outboundResult) {
          setOutboundReturnPurchaseEntry({
            mode: outboundPayload.mode,
            result: outboundResult,
            purchasedAt: new Date().toISOString(),
          });
        }
      }

      // Return label: buyer → seller (swap addresses)
      const returnShipmentData = roundTripShipments.returnShipment;
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

      const returnPayload = await readJsonResponse<ShippingPostagePurchaseResponse>(
        returnResponse,
        "Failed to buy return label.",
      );
      const returnResult = returnPayload.results[0];

      if (returnResult) {
        setReturnOnlyPurchaseEntry({
          mode: returnPayload.mode,
          result: returnResult,
          purchasedAt: new Date().toISOString(),
        });
      }
    } catch (purchaseError) {
      setError(String(purchaseError));
    } finally {
      setIsPurchasingReturn(false);
    }
  };

  // ── Handler: reset workflow ───────────────────────────────────────────────
  const handleReset = () => {
    dismissRestoredWorkflow();
    setCurrentStep(0);
    void applyOrderSource([], "");
  };

  // ── Derived for the header and step bar ───────────────────────────────────
  const selectedModeHasApiKey =
    config.easypostMode === "test"
      ? environmentStatus.hasTestApiKey
      : environmentStatus.hasProductionApiKey;
  // Production with its key is the normal state, so only the exceptions are shown.
  const modeWarning = !selectedModeHasApiKey
    ? `Missing ${config.easypostMode} API key`
    : config.easypostMode === "test"
      ? "Test mode"
      : null;

  const step = OUTBOUND_STEPS[currentStep];
  const nextStep = OUTBOUND_STEPS[currentStep + 1] ?? null;
  const stepProgress = describeShippingStep(step.key, {
    orderCount: sourceOrders.length,
    isLoadingOrders: isLoadingLiveOrders || isLoadingSingleOrder || isLoadingExistingPostage,
    itemCount: sourceOrders.reduce((sum, order) => sum + order["Item Count"], 0),
    shipmentCount: shipments.length,
    purchasedCount: shipments.filter(
      (shipment) => outboundPurchaseResultsByReference[shipment.reference]?.result.status === "purchased",
    ).length,
    packedCount: packedOrderNumbers.size,
    shipPendingCount: unshippedOrderCount,
    shippedCount: shippedOrderCount,
    hasSellerKey,
  });
  // Packing compares one shipment at a time; every other step works on the whole batch.
  const packShipmentReference = shipmentReferences[packShipmentIndex] ?? null;
  const stepValue = useMemo(() => {
    const orders =
      step.key === "pack"
        ? packShipmentReference
          ? getOrdersForShipmentReference(sourceOrders, shipmentToOrderMap, packShipmentReference)
          : []
        : sourceOrders;
    return orders.length > 0 ? saleValueOfOrders(orders) : null;
  }, [step.key, packShipmentReference, sourceOrders, shipmentToOrderMap]);
  const stepActions: Partial<Record<typeof step.key, ShippingStepAction>> = {
    "buy-postage": {
      label: purchasingLabelSize ? `Buying ${purchasingLabelSize} Postage...` : "Buy All Postage",
      busy: purchasingLabelSize !== null,
      disabled:
        availableLabelSizes.length === 0 ||
        !selectedModeHasApiKey ||
        purchasingLabelSize !== null ||
        purchasingActionKey !== null,
      color: config.easypostMode === "test" ? "warning" : "primary",
      onClick: () => void handleBuyPostage(),
    },
    ship: {
      label: isShipping ? "Marking Shipped..." : "Mark Shipped & Notify Buyers",
      busy: isShipping,
      disabled: shipPendingOrderNumbers.length === 0 || isShipping || !hasSellerKey,
      onClick: () => void handleShip(),
    },
  };

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        px: 3,
        py: 2,
        boxSizing: "border-box",
        height: { md: "calc(100dvh - 64px)" },
      }}
    >
      <Stack spacing={2} sx={{ flexShrink: 0 }}>
        <Stack direction="row" alignItems="center" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Typography variant="h5" component="h1">
            Shipping Workflow
          </Typography>
          <Stepper nonLinear activeStep={currentStep} sx={{ flex: "1 1 640px" }}>
            {OUTBOUND_STEPS.map((outboundStep, index) => (
              <Step key={outboundStep.key} completed={index < currentStep}>
                <StepButton onClick={() => setCurrentStep(index)}>
                  {outboundStep.label}
                </StepButton>
              </Step>
            ))}
          </Stepper>
          {modeWarning && <Chip color="warning" label={modeWarning} />}
          <Button
            variant="outlined"
            startIcon={<ReplyIcon />}
            aria-haspopup="dialog"
            onClick={() => setReturnsOpen(true)}
          >
            Return labels
          </Button>
          <Tooltip title="Shipping configuration">
            <IconButton component={Link} to="/shipping-configuration" aria-label="Shipping configuration">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {restoredWorkflow && (
          <Alert
            severity="info"
            action={
              <>
                <Button color="inherit" size="small" onClick={handleReset}>
                  Start over
                </Button>
                <Button color="inherit" size="small" onClick={dismissRestoredWorkflow}>
                  Dismiss
                </Button>
              </>
            }
          >
            Restored your in-progress shipping workflow
            {restoredWorkflow.loadedSourceLabel ? ` (${restoredWorkflow.loadedSourceLabel})` : ""} saved{" "}
            {new Date(restoredWorkflow.savedAt).toLocaleString()}.
          </Alert>
        )}
      </Stack>

      <Paper
        component="section"
        aria-label={step.label}
        elevation={2}
        sx={{ p: 3, flex: 1, minHeight: 0, overflow: "auto" }}
      >
        {step.key === "load-orders" && (
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
            historyCoverage={historyCoverage}
            isUpdatingHistory={isUpdatingHistory}
            onCatchUpHistory={() => void updateSellerOrderHistory({
              action: "catch_up",
              orderNumbers: sourceOrders.map((order) => order["Order #"]),
            })}
            onImportHistoryFile={(file) => void handleImportHistoryFile(file)}
          />
        )}

        {step.key === "pull-sheet" && (
          <PullSheetStep
            sourceOrders={sourceOrders}
            shipments={shipments}
            pullSheetItems={pullSheetItems}
            isLoadingPullSheet={isGeneratingPullSheet}
            pullSheetError={pullSheetError}
          />
        )}

        {step.key === "buy-postage" && (
          <BuyPostageStep
            config={config}
            environmentStatus={environmentStatus}
            shipments={shipments}
            sourceOrders={sourceOrders}
            shipmentToOrderMap={shipmentToOrderMap}
            outboundPurchaseResultsByReference={outboundPurchaseResultsByReference}
            returnPurchaseResultsByReference={returnPurchaseResultsByReference}
            isPurchasing={purchasingLabelSize !== null || purchasingActionKey !== null}
            purchasingActionKey={purchasingActionKey}
            onBuyShipment={(s) => void handleBuyShipment(s)}
            onBuyReturnLabel={(s) => void handleBuyReturnLabel(s)}
            onEditShipment={handleOpenEditDrawer}
            onDownloadShipment={handleDownloadShipment}
            onDownloadReturnShipment={handleDownloadReturnShipment}
          />
        )}

        {step.key === "print" && (
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
          />
        )}

        {step.key === "pack" && (
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
            currentIndex={packShipmentIndex}
            onCurrentIndexChange={setPackShipmentIndex}
          />
        )}

        {step.key === "ship" && (
          <ShipStep
            pendingOrderNumbers={shipPendingOrderNumbers}
            shippedOrderCount={shippedOrderCount}
            trackingApplyResults={trackingApplyResults}
            shippedMessageResults={shippedMessageResults}
            hasSellerKey={hasSellerKey}
          />
        )}
      </Paper>

      <ShippingStepBar
        progress={stepProgress}
        action={stepActions[step.key]}
        nextStepLabel={nextStep?.label ?? null}
        onBack={currentStep > 0 ? () => setCurrentStep(currentStep - 1) : undefined}
        onNext={() => setCurrentStep(currentStep + 1)}
        onStartNewBatch={handleReset}
        startNewBatchWarning={
          unshippedOrderCount > 0
            ? `${unshippedOrderCount} ${unshippedOrderCount === 1 ? "order is" : "orders are"} not yet marked shipped with the buyer notified. Starting a new batch clears this one.`
            : null
        }
        value={
          stepValue && (
            <Stack direction="row" alignItems="center" spacing={1}>
              {step.key === "pack" && (
                <Typography variant="body2" color="text.secondary">
                  Shipment
                </Typography>
              )}
              <SaleValueFigures value={stepValue} />
            </Stack>
          )
        }
      />

      <Drawer anchor="right" open={returnsOpen} onClose={() => setReturnsOpen(false)}>
        <Box
          role="region"
          aria-labelledby="return-labels-heading"
          sx={{ width: { xs: "100vw", sm: 560 }, p: 3 }}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
            <Typography id="return-labels-heading" variant="h6">
              Return labels
            </Typography>
            <IconButton aria-label="Close return labels" onClick={() => setReturnsOpen(false)}>
              <CloseIcon />
            </IconButton>
          </Stack>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          <ReturnFlowPanel
            config={config}
            environmentStatus={environmentStatus}
            sellerKeyInput={sellerKeyInput}
            orderNumberInput={returnOrderNumberInput}
            returnOrder={returnOrder}
            returnShipment={returnShipment}
            returnFlowType={returnFlowType}
            returnService={returnService}
            outboundReturnPurchaseEntry={outboundReturnPurchaseEntry}
            returnOnlyPurchaseEntry={returnOnlyPurchaseEntry}
            isLoadingReturnOrder={isLoadingReturnOrder}
            isLoadingReturnLabels={isLoadingReturnLabels}
            isPurchasingReturn={isPurchasingReturn}
            onOrderNumberChange={setReturnOrderNumberInput}
            onLookupOrder={() => void handleLookupReturnOrder()}
            onReturnFlowTypeChange={setReturnFlowType}
            onReturnServiceChange={setReturnService}
            onBuyLabels={() => void handleBuyReturnFlowLabels()}
          />
        </Box>
      </Drawer>

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
