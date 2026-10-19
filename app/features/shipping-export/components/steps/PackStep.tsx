import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import GridViewIcon from "@mui/icons-material/GridView";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import ListIcon from "@mui/icons-material/List";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PullSheetGrid } from "~/features/pull-sheet/components/PullSheetGrid";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import {
  saleValueOfLines,
  saleValueOfOrders,
  saleValuesBySku,
  type SaleValue,
} from "../../services/saleValue";
import { getOrderNumbersForShipmentReference } from "../../services/shippingExportUtils";
import { SaleValueFigures } from "../SaleValueFigures";
import { shippingInventorySkuId } from "../../services/shippingOrderIdentity";
import { packShortcutFor, type PackShortcut } from "../../services/packShortcut";
import type {
  PackPullSheetLoadStatus,
  PackPullSheetShipmentMatch,
} from "../../services/packPullSheet";
import {
  getPullSheetItemsForOrder,
} from "../../services/packPullSheet";
import type {
  OrderLineItem,
  ShipmentToOrderMap,
  ShippingPostagePurchaseEntry,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";

type FallbackRow = {
  key: string;
  name: string;
  quantity: number;
  /** Shown on the first row for each SKU, so a repeated SKU is not counted twice. */
  value: SaleValue | null;
};

function buildFallbackRowsFromPullSheet(
  order: TcgPlayerShippingOrder,
  items: PullSheetItem[],
): FallbackRow[] {
  const shown = new Set<number>();
  return items.map((item, index) => {
    const first = !shown.has(item.skuId);
    shown.add(item.skuId);
    return {
      key: `${order["Order #"]}-${item.skuId}-${index}`,
      name: item.productName,
      quantity: item.quantity,
      value: first ? saleValueOfLines([order], (line) => line.skuId === item.skuId) : null,
    };
  });
}

function lineGroupKey(line: OrderLineItem): string {
  const identity = shippingInventorySkuId(line);
  return identity ? `sku:${identity}` : `name:${line.name}`;
}

function buildFallbackRowsFromLines(order: TcgPlayerShippingOrder): FallbackRow[] {
  const groups = new Map<string, { index: number; name: string; quantity: number }>();

  (order.products ?? []).forEach((line, index) => {
    const key = lineGroupKey(line);
    const group = groups.get(key);
    if (group) {
      group.quantity += line.quantity;
      return;
    }
    groups.set(key, { index, name: line.name, quantity: line.quantity });
  });

  return Array.from(groups.entries()).map(([groupKey, group]) => ({
    key: `${order["Order #"]}-${groupKey}-${group.index}`,
    name: group.name,
    quantity: group.quantity,
    value: saleValueOfLines([order], (line) => lineGroupKey(line) === groupKey),
  }));
}

function formatAddress(order: TcgPlayerShippingOrder): string {
  return [
    `${order.FirstName} ${order.LastName}`,
    order.Address1,
    order.Address2,
    `${order.City}, ${order.State} ${order.PostalCode}`,
    order.Country,
  ]
    .filter(Boolean)
    .join("\n");
}

function postageChipColor(entry: ShippingPostagePurchaseEntry) {
  return entry.result.status === "purchased"
    ? "success"
    : entry.result.status === "failed"
      ? "error"
      : "warning";
}

/** One order of the shipment: its number and value line above its cards. */
function OrderSection({
  order,
  value,
  children,
}: {
  order: TcgPlayerShippingOrder;
  value: SaleValue;
  children: ReactNode;
}) {
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="subtitle2" fontWeight={600}>
            Order {order["Order #"]}
          </Typography>
          <SaleValueFigures value={value} />
        </Stack>
        {children}
      </Stack>
    </Box>
  );
}

interface PackStepProps {
  sourceOrders: TcgPlayerShippingOrder[];
  shipmentReferences: string[];
  shipmentToOrderMap: ShipmentToOrderMap;
  outboundPurchaseResultsByReference: Record<string, ShippingPostagePurchaseEntry>;
  packPullSheetStatus: PackPullSheetLoadStatus;
  packPullSheetError: string | null;
  packPullSheetMatchesByReference: Record<string, PackPullSheetShipmentMatch>;
  packedOrderNumbers: Set<string>;
  onOrderPacked: (reference: string, packed: boolean) => void;
  initialViewMode?: ViewMode;
}

type ViewMode = "card" | "list";

export function PackStep({
  sourceOrders,
  shipmentReferences,
  shipmentToOrderMap,
  outboundPurchaseResultsByReference,
  packPullSheetStatus,
  packPullSheetError,
  packPullSheetMatchesByReference,
  packedOrderNumbers,
  onOrderPacked,
  initialViewMode = "card",
}: PackStepProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);

  const totalShipments = shipmentReferences.length;
  const currentReference = shipmentReferences[currentIndex] ?? null;
  const currentOrder =
    sourceOrders.find((order) => order["Order #"] === currentReference) ?? null;

  const mergedOrderNumbers = currentReference
    ? getOrderNumbersForShipmentReference(shipmentToOrderMap, currentReference)
    : [];
  const mergedOrders = mergedOrderNumbers
    .map((orderNumber) =>
      sourceOrders.find((order) => order["Order #"] === orderNumber),
    )
    .filter((order): order is TcgPlayerShippingOrder => order !== undefined);

  const purchaseEntry = currentReference
    ? outboundPurchaseResultsByReference[currentReference]
    : null;
  const visualPullSheetMatch = currentReference
    ? packPullSheetMatchesByReference[currentReference] ?? null
    : null;
  const isPacked = currentReference
    ? packedOrderNumbers.has(currentReference)
    : false;

  const allLineItems = mergedOrders.flatMap((order) => order.products ?? []);
  const hasLineItems = allLineItems.length > 0;
  const orderedPullSheetItems = visualPullSheetMatch?.items ?? [];

  function renderFallbackPullSheetTable(tableRows: FallbackRow[]) {
    if (tableRows.length === 0) {
      return null;
    }

    return (
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Card</TableCell>
              <TableCell align="right">Qty</TableCell>
              <TableCell>Value</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tableRows.map((row) => (
              <TableRow key={row.key}>
                <TableCell>{row.name}</TableCell>
                <TableCell align="right">{row.quantity}</TableCell>
                <TableCell>{row.value ? <SaleValueFigures value={row.value} /> : "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  }

  const orderSections = mergedOrders.map((order) => {
    const orderPullSheetItems = getPullSheetItemsForOrder(
      orderedPullSheetItems,
      order["Order #"],
    );
    const fallbackRows =
      orderPullSheetItems.length > 0
        ? buildFallbackRowsFromPullSheet(order, orderPullSheetItems)
        : buildFallbackRowsFromLines(order);

    return {
      order,
      orderPullSheetItems,
      fallbackRows,
      value: saleValueOfOrders([order]),
      cardValues: saleValuesBySku([order]),
    };
  });

  function handleMarkPacked(reference: string, packed: boolean) {
    onOrderPacked(reference, packed);

    if (packed) {
      const nextUnpacked = shipmentReferences.findIndex(
        (shipmentReference, index) =>
          index > currentIndex && !packedOrderNumbers.has(shipmentReference),
      );

      if (nextUnpacked !== -1) {
        setCurrentIndex(nextUnpacked);
      } else {
        const firstUnpacked = shipmentReferences.findIndex(
          (shipmentReference) =>
            shipmentReference !== reference &&
            !packedOrderNumbers.has(shipmentReference),
        );

        if (firstUnpacked !== -1) {
          setCurrentIndex(firstUnpacked);
        }
      }
    }
  }

  const pageRef = useRef<HTMLDivElement>(null);
  const applyShortcut = useRef<(shortcut: PackShortcut) => void>(() => undefined);
  applyShortcut.current = (shortcut) => {
    if (shortcut === "previous") {
      setCurrentIndex((index) => Math.max(0, index - 1));
    } else if (shortcut === "next") {
      setCurrentIndex((index) => Math.min(totalShipments - 1, index + 1));
    } else if (currentReference) {
      handleMarkPacked(currentReference, !isPacked);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Dialogs, menus, and drawers render outside the page; their keys are their own.
      const target = event.target;
      if (target instanceof Node && target !== document.body && !pageRef.current?.contains(target)) {
        return;
      }
      const element = target instanceof HTMLElement && target !== document.body ? target : null;
      const shortcut = packShortcutFor({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        target: element && {
          tagName: element.tagName,
          type: element instanceof HTMLInputElement ? element.type : undefined,
          role: element.getAttribute("role"),
          isContentEditable: element.isContentEditable,
        },
      });
      if (shortcut) {
        event.preventDefault();
        applyShortcut.current(shortcut);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const itemCount = mergedOrders.reduce((sum, order) => sum + order["Item Count"], 0);

  return (
    <Stack ref={pageRef} spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
        {viewMode === "card" ? (
          <Stack direction="row" alignItems="center">
            <IconButton
              size="small"
              aria-label="Previous shipment"
              onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
              disabled={currentIndex === 0}
            >
              <ChevronLeftIcon />
            </IconButton>
            <Typography variant="body1" fontWeight={600} sx={{ whiteSpace: "nowrap" }}>
              Shipment {currentIndex + 1} of {totalShipments}
            </Typography>
            <IconButton
              size="small"
              aria-label="Next shipment"
              onClick={() => setCurrentIndex((index) => Math.min(totalShipments - 1, index + 1))}
              disabled={currentIndex >= totalShipments - 1}
            >
              <ChevronRightIcon />
            </IconButton>
          </Stack>
        ) : (
          <Typography variant="body1" fontWeight={600}>
            All Shipments
          </Typography>
        )}

        {viewMode === "card" && currentOrder && (
          <>
            {mergedOrderNumbers.length > 1 ? (
              <Tooltip title={mergedOrderNumbers.join(", ")}>
                <Chip label={`Combined shipment of ${mergedOrderNumbers.length} orders`} size="small" />
              </Tooltip>
            ) : (
              <Chip label={currentReference} size="small" variant="outlined" />
            )}
            <Tooltip title={<Box sx={{ whiteSpace: "pre-line" }}>{formatAddress(currentOrder)}</Box>}>
              <Typography variant="body2" noWrap>
                {currentOrder.FirstName} {currentOrder.LastName} · {currentOrder.City}, {currentOrder.State}
              </Typography>
            </Tooltip>
            <Typography variant="body2" color="text.secondary" noWrap>
              {currentOrder["Shipping Method"]} · {itemCount} {itemCount === 1 ? "item" : "items"}
            </Typography>
            {purchaseEntry && (
              <Tooltip title={purchaseEntry.result.trackingCode ?? ""}>
                <Chip
                  label={purchaseEntry.result.status.toUpperCase()}
                  size="small"
                  color={postageChipColor(purchaseEntry)}
                />
              </Tooltip>
            )}
          </>
        )}

        <Box sx={{ flex: 1 }} />

        {viewMode === "card" && currentReference && (
          <Button
            size="small"
            color="success"
            variant={isPacked ? "contained" : "outlined"}
            aria-pressed={isPacked}
            startIcon={isPacked ? <CheckBoxIcon /> : <CheckBoxOutlineBlankIcon />}
            onClick={() => handleMarkPacked(currentReference, !isPacked)}
          >
            {isPacked ? "Packed" : "Mark Packed"}
          </Button>
        )}
        <Tooltip title="Space marks the shipment packed and moves to the next one. Left and right arrows move between shipments.">
          <KeyboardIcon fontSize="small" color="action" aria-label="Keyboard shortcuts" />
        </Tooltip>
        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={(_, value) => value && setViewMode(value)}
          size="small"
        >
          <ToggleButton value="card" aria-label="card view">
            <GridViewIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton value="list" aria-label="list view">
            <ListIcon fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {viewMode === "card" && (
        <>
          {currentOrder ? (
            <Stack spacing={1.5}>
              {mergedOrders.length > 1 && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" color="text.secondary">
                    Shipment value
                  </Typography>
                  <SaleValueFigures value={saleValueOfOrders(mergedOrders)} />
                </Stack>
              )}

              {!hasLineItems && (
                <Alert severity="info">
                  Line item details unavailable - refer to the packing slip PDF.
                </Alert>
              )}

              {hasLineItems && packPullSheetStatus === "loading" && (
                <Alert severity="info">
                  Loading visual pull sheet for this shipment.
                </Alert>
              )}

              {hasLineItems && packPullSheetStatus === "error" && (
                <Alert severity="warning">
                  {packPullSheetError ??
                    "Visual pull sheet unavailable. Showing the shipment item list instead."}
                </Alert>
              )}

              {hasLineItems &&
                visualPullSheetMatch?.fallbackReason &&
                packPullSheetStatus !== "loading" && (
                  <Alert severity="info">
                    {visualPullSheetMatch.fallbackReason} Showing the shipment
                    item list instead.
                  </Alert>
                )}

              {hasLineItems &&
                visualPullSheetMatch?.canRenderGrid &&
                packPullSheetStatus === "ready" &&
                orderSections.map(({ order, orderPullSheetItems, value, cardValues }) => (
                  <OrderSection key={order["Order #"]} order={order} value={value}>
                    <PullSheetGrid
                      items={orderPullSheetItems}
                      renderItemDetail={(item) => {
                        const cardValue = cardValues.get(item.skuId);
                        return cardValue ? (
                          <SaleValueFigures value={cardValue} variant="caption" onImage />
                        ) : null;
                      }}
                    />
                  </OrderSection>
                ))}

              {hasLineItems &&
                packPullSheetStatus !== "loading" &&
                (!visualPullSheetMatch?.canRenderGrid || packPullSheetStatus === "error") &&
                orderSections.map(({ order, fallbackRows, value }) => (
                  <OrderSection key={order["Order #"]} order={order} value={value}>
                    {renderFallbackPullSheetTable(fallbackRows)}
                  </OrderSection>
                ))}
            </Stack>
          ) : (
            <Alert severity="warning">
              No order found for this shipment reference.
            </Alert>
          )}
        </>
      )}

      {viewMode === "list" && (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Order(s)</TableCell>
                <TableCell>Recipient</TableCell>
                <TableCell>Method</TableCell>
                <TableCell align="right">Items</TableCell>
                <TableCell>Value</TableCell>
                <TableCell>Postage</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shipmentReferences.map((shipmentReference, index) => {
                const orderNumbers = getOrderNumbersForShipmentReference(
                  shipmentToOrderMap,
                  shipmentReference,
                );
                const primaryOrder =
                  sourceOrders.find(
                    (order) => order["Order #"] === shipmentReference,
                  ) ?? null;
                const rowOrders = orderNumbers
                  .map((orderNumber) =>
                    sourceOrders.find((order) => order["Order #"] === orderNumber),
                  )
                  .filter((order): order is TcgPlayerShippingOrder => order !== undefined);
                const purchase = outboundPurchaseResultsByReference[shipmentReference];
                const packed = packedOrderNumbers.has(shipmentReference);

                return (
                  <TableRow
                    key={shipmentReference}
                    selected={index === currentIndex}
                    hover
                    onClick={() => setCurrentIndex(index)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={packed}
                        onChange={(event) => {
                          event.stopPropagation();
                          handleMarkPacked(shipmentReference, event.target.checked);
                        }}
                        color="success"
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      {orderNumbers.length > 1 ? (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap">
                          {orderNumbers.map((orderNumber) => (
                            <Chip
                              key={orderNumber}
                              label={orderNumber}
                              size="small"
                              variant="outlined"
                            />
                          ))}
                        </Stack>
                      ) : (
                        <Typography variant="body2">{shipmentReference}</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {primaryOrder
                        ? `${primaryOrder.FirstName} ${primaryOrder.LastName}`
                        : "-"}
                    </TableCell>
                    <TableCell>{primaryOrder?.["Shipping Method"] ?? "-"}</TableCell>
                    <TableCell align="right">
                      {rowOrders.reduce((sum, order) => sum + order["Item Count"], 0)}
                    </TableCell>
                    <TableCell sx={{ minWidth: 420 }}>
                      <SaleValueFigures value={saleValueOfOrders(rowOrders)} />
                    </TableCell>
                    <TableCell>
                      {purchase ? (
                        <Chip
                          label={purchase.result.status.toUpperCase()}
                          size="small"
                          color={postageChipColor(purchase)}
                        />
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
