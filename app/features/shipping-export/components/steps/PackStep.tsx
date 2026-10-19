import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import GridViewIcon from "@mui/icons-material/GridView";
import ListIcon from "@mui/icons-material/List";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useState } from "react";
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
    .filter((order): order is TcgPlayerShippingOrder => order !== null);

  const purchaseEntry = currentReference
    ? outboundPurchaseResultsByReference[currentReference]
    : null;
  const visualPullSheetMatch = currentReference
    ? packPullSheetMatchesByReference[currentReference] ?? null
    : null;
  const isPacked = currentReference
    ? packedOrderNumbers.has(currentReference)
    : false;
  const packedCount = packedOrderNumbers.size;
  const progress = totalShipments > 0 ? (packedCount / totalShipments) * 100 : 0;

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

  return (
    <Stack spacing={3}>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        justifyContent="space-between"
      >
        <Stack direction="row" spacing={1} alignItems="center">
          {viewMode === "card" && (
            <>
              <IconButton
                onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
                disabled={currentIndex === 0}
              >
                <ChevronLeftIcon />
              </IconButton>
              <Typography variant="body1" fontWeight={600}>
                Shipment {currentIndex + 1} of {totalShipments}
              </Typography>
              <IconButton
                onClick={() =>
                  setCurrentIndex((index) =>
                    Math.min(totalShipments - 1, index + 1),
                  )
                }
                disabled={currentIndex === totalShipments - 1}
              >
                <ChevronRightIcon />
              </IconButton>
            </>
          )}
          {viewMode === "list" && (
            <Typography variant="body1" fontWeight={600}>
              All Shipments
            </Typography>
          )}
        </Stack>

        <Stack direction="row" spacing={2} alignItems="center">
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              {packedCount} of {totalShipments} packed
            </Typography>
            <Chip
              label={`${Math.round(progress)}%`}
              size="small"
              color={packedCount === totalShipments ? "success" : "default"}
            />
          </Stack>
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
      </Stack>

      <LinearProgress
        variant="determinate"
        value={progress}
        color={packedCount === totalShipments ? "success" : "primary"}
        sx={{ height: 8, borderRadius: 4 }}
      />

      {viewMode === "card" && (
        <>
          {currentOrder ? (
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={3}>
                  <Stack
                    direction={{ xs: "column", lg: "row" }}
                    spacing={2}
                    alignItems={{ xs: "stretch", lg: "flex-start" }}
                    justifyContent="space-between"
                  >
                    <Stack spacing={1.5} flex={1}>
                      <Stack
                        direction={{ xs: "column", sm: "row" }}
                        spacing={1}
                        alignItems={{ xs: "flex-start", sm: "center" }}
                        justifyContent="space-between"
                      >
                        <Typography variant="subtitle1" fontWeight={600}>
                          Shipment Details
                        </Typography>

                        {mergedOrderNumbers.length > 1 ? (
                          <Stack direction="row" spacing={0.5} flexWrap="wrap">
                            {mergedOrderNumbers.map((orderNumber) => (
                              <Chip
                                key={orderNumber}
                                label={orderNumber}
                                size="small"
                                variant="outlined"
                              />
                            ))}
                            <Chip
                              label="Combined shipment"
                              size="small"
                              color="default"
                            />
                          </Stack>
                        ) : (
                          <Chip
                            label={currentReference}
                            size="small"
                            variant="outlined"
                          />
                        )}
                      </Stack>

                      <Stack
                        direction="row"
                        spacing={2}
                        useFlexGap
                        flexWrap="wrap"
                        alignItems="flex-start"
                      >
                        <Box sx={{ minWidth: 180, flex: "1 1 180px" }}>
                          <Typography variant="body2" color="text.secondary">
                            Recipient
                          </Typography>
                          <Typography variant="body2">
                            {currentOrder.FirstName} {currentOrder.LastName}
                          </Typography>
                        </Box>

                        <Box sx={{ minWidth: 240, flex: "2 1 280px" }}>
                          <Typography variant="body2" color="text.secondary">
                            Address
                          </Typography>
                          <Typography
                            variant="body2"
                            component="pre"
                            sx={{
                              m: 0,
                              whiteSpace: "pre-wrap",
                              fontFamily: "inherit",
                            }}
                          >
                            {[
                              currentOrder.Address1,
                              currentOrder.Address2,
                              `${currentOrder.City}, ${currentOrder.State} ${currentOrder.PostalCode}`,
                              currentOrder.Country,
                            ]
                              .filter(Boolean)
                              .join("\n")}
                          </Typography>
                        </Box>

                        <Box sx={{ minWidth: 96 }}>
                          <Typography variant="body2" color="text.secondary">
                            Items
                          </Typography>
                          <Typography variant="body2">
                            {mergedOrders.reduce(
                              (sum, order) => sum + order["Item Count"],
                              0,
                            )}
                          </Typography>
                        </Box>

                        {mergedOrders.length > 1 && (
                          <Box sx={{ flex: "1 1 100%" }}>
                            <Typography variant="body2" color="text.secondary">
                              Shipment value
                            </Typography>
                            <SaleValueFigures value={saleValueOfOrders(mergedOrders)} />
                          </Box>
                        )}

                        <Box sx={{ minWidth: 128 }}>
                          <Typography variant="body2" color="text.secondary">
                            Method
                          </Typography>
                          <Typography variant="body2">
                            {currentOrder["Shipping Method"]}
                          </Typography>
                        </Box>

                        {purchaseEntry && (
                          <Box sx={{ minWidth: 180 }}>
                            <Typography variant="body2" color="text.secondary">
                              Postage
                            </Typography>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Chip
                                label={purchaseEntry.result.status.toUpperCase()}
                                size="small"
                                color={
                                  purchaseEntry.result.status === "purchased"
                                    ? "success"
                                    : purchaseEntry.result.status === "failed"
                                      ? "error"
                                      : "warning"
                                }
                              />
                              {purchaseEntry.result.trackingCode && (
                                <Typography variant="body2" color="text.secondary">
                                  {purchaseEntry.result.trackingCode}
                                </Typography>
                              )}
                            </Stack>
                          </Box>
                        )}
                      </Stack>
                    </Stack>

                    <Box
                      sx={{
                        border: 1,
                        borderColor: isPacked ? "success.main" : "divider",
                        borderRadius: 2,
                        px: 2,
                        py: 1,
                        alignSelf: { xs: "stretch", lg: "center" },
                        bgcolor: isPacked ? "success.light" : "background.paper",
                      }}
                    >
                      <FormControlLabel
                        sx={{ m: 0 }}
                        control={
                          <Checkbox
                            checked={isPacked}
                            onChange={(_, checked) => {
                              if (currentReference) {
                                handleMarkPacked(currentReference, checked);
                              }
                            }}
                            color="success"
                          />
                        }
                        label={<Typography fontWeight={600}>Mark as Packed</Typography>}
                      />
                    </Box>
                  </Stack>

                      <Stack spacing={1.5}>
                    <Typography variant="subtitle1" fontWeight={600}>
                      Pull Sheet
                    </Typography>

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
                      packPullSheetStatus === "ready" && (
                        <Stack spacing={2}>
                          {orderSections.map(
                            ({ order, orderPullSheetItems, value, cardValues }) => (
                              <Box
                                key={order["Order #"]}
                                sx={{
                                  border: 1,
                                  borderColor: "divider",
                                  borderRadius: 2,
                                  p: 2,
                                }}
                              >
                                <Stack spacing={1.5}>
                                  <Stack
                                    direction={{ xs: "column", sm: "row" }}
                                    spacing={1}
                                    alignItems={{ xs: "flex-start", sm: "center" }}
                                    justifyContent="space-between"
                                  >
                                    <Typography variant="subtitle2" fontWeight={600}>
                                      Order {order["Order #"]}
                                    </Typography>
                                    <SaleValueFigures value={value} />
                                  </Stack>
                                  <PullSheetGrid
                                    items={orderPullSheetItems}
                                    renderItemDetail={(item) => {
                                      const cardValue = cardValues.get(item.skuId);
                                      return cardValue ? (
                                        <SaleValueFigures value={cardValue} variant="caption" onImage />
                                      ) : null;
                                    }}
                                  />
                                </Stack>
                              </Box>
                            ),
                          )}
                        </Stack>
                      )}

                    {hasLineItems &&
                      packPullSheetStatus !== "loading" &&
                      (!visualPullSheetMatch?.canRenderGrid ||
                        packPullSheetStatus === "error") &&
                      (
                        <Stack spacing={2}>
                          {orderSections.map(({ order, fallbackRows, value }) => (
                            <Box
                              key={order["Order #"]}
                              sx={{
                                border: 1,
                                borderColor: "divider",
                                borderRadius: 2,
                                p: 2,
                              }}
                            >
                              <Stack spacing={1.5}>
                                <Stack
                                  direction={{ xs: "column", sm: "row" }}
                                  spacing={1}
                                  alignItems={{ xs: "flex-start", sm: "center" }}
                                  justifyContent="space-between"
                                >
                                  <Typography variant="subtitle2" fontWeight={600}>
                                    Order {order["Order #"]}
                                  </Typography>
                                  <SaleValueFigures value={value} />
                                </Stack>
                                {renderFallbackPullSheetTable(fallbackRows)}
                              </Stack>
                            </Box>
                          ))}
                        </Stack>
                      )}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
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
                  .filter((order): order is TcgPlayerShippingOrder => order !== null);
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
                          color={
                            purchase.result.status === "purchased"
                              ? "success"
                              : purchase.result.status === "failed"
                                ? "error"
                                : "warning"
                          }
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
