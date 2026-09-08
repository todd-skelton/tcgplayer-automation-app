import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import GridViewIcon from "@mui/icons-material/GridView";
import ListIcon from "@mui/icons-material/List";
import {
  Alert,
  Box,
  Button,
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
import { formatUsd } from "~/core/utils/marketDelta";
import { PullSheetGrid } from "~/features/pull-sheet/components/PullSheetGrid";
import type {
  PullSheetItem,
  PullSheetPriceBadge,
} from "~/features/pull-sheet/types/pullSheetTypes";
import {
  compareLinesToMarket,
  compareOrderToMarket,
  compareOrdersToMarket,
  describeMarketCoverage,
  type MarketComparison,
} from "../../services/orderMarketComparison";
import { getOrderNumbersForShipmentReference } from "../../services/shippingExportUtils";
import { MarketDeltaChip } from "../MarketDeltaChip";
import { IntakeHistorySummary } from "../IntakeHistorySummary";
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
  ShippingIntakeLineHistory,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";

type FallbackRow = {
  key: string;
  name: string;
  quantity: number;
  /** Comparison for just this row, so sold and market cells can be shown per card. */
  comparison: MarketComparison | null;
  intakeHistory: ShippingIntakeLineHistory | null;
};

function findLineForSku(lines: OrderLineItem[], skuId: number): OrderLineItem | undefined {
  return lines.find((line) => line.skuId === skuId);
}

function buildPriceBadgesBySku(order: TcgPlayerShippingOrder): Record<number, PullSheetPriceBadge> {
  const badges: Record<number, PullSheetPriceBadge> = {};
  const histories = new Map((order.intakeHistory?.lines ?? []).map((line) => [line.skuId, line]));
  const grouped = new Map<number, { quantity: number; sold: number; marketQuantity: number; market: number }>();
  for (const line of order.products ?? []) {
    if (line.skuId === undefined) continue;
    const value = grouped.get(line.skuId) ?? { quantity: 0, sold: 0, marketQuantity: 0, market: 0 };
    value.quantity += line.quantity; value.sold += line.unitPrice * line.quantity;
    if (line.marketPrice !== undefined) { value.marketQuantity += line.quantity; value.market += line.marketPrice * line.quantity; }
    grouped.set(line.skuId, value);
  }
  for (const [sku, value] of grouped) {
    const history = histories.get(String(sku));
    badges[sku] = { soldPrice: value.sold / value.quantity,
      ...(value.marketQuantity === value.quantity ? { marketPrice: value.market / value.quantity } : {}),
      ...(history ? { intakeMarketTotal: history.intakeMarketTotal, intakeOrderedQuantity: history.orderedQuantity,
        intakePriceKnownQuantity: history.priceKnownQuantity, intakeDateKnownQuantity: history.dateKnownQuantity,
        intakeWeightedDaysHeld: history.weightedDaysHeld, intakeStatus: history.status } : {}),
    };
  }

  return badges;
}

function buildFallbackRowsFromPullSheet(
  orderNumber: string,
  items: PullSheetItem[],
  lines: OrderLineItem[],
  histories: Map<string, ShippingIntakeLineHistory>,
): FallbackRow[] {
  const shownHistory = new Set<string>();
  return items.map((item, index) => {
    const line = findLineForSku(lines, item.skuId);
    const history = histories.get(String(item.skuId));
    const intakeHistory = history && !shownHistory.has(history.skuId) ? history : null;
    if (history) shownHistory.add(history.skuId);

    return {
      key: `${orderNumber}-${item.skuId}-${index}`,
      name: item.productName,
      quantity: item.quantity,
      comparison: line
        ? compareLinesToMarket([{ ...line, quantity: item.quantity }])
        : null,
      intakeHistory,
    };
  });
}

function buildFallbackRowsFromLines(orderNumber: string, lines: OrderLineItem[], histories: Map<string, ShippingIntakeLineHistory>): FallbackRow[] {
  const linesByName = new Map<string, { index: number; lines: OrderLineItem[] }>();

  lines.forEach((line, index) => {
    const group = linesByName.get(line.name);

    if (group) {
      group.lines.push(line);
      return;
    }

    linesByName.set(line.name, { index, lines: [line] });
  });

  const shownHistory = new Set<string>();
  return Array.from(linesByName.entries()).map(([name, group]) => {
    const skuId = group.lines[0]?.inventorySkuId ?? (group.lines[0]?.skuId === undefined ? null : String(group.lines[0].skuId));
    const history = skuId ? histories.get(skuId) : undefined;
    const intakeHistory = history && !shownHistory.has(history.skuId) ? history : null;
    if (history) shownHistory.add(history.skuId);
    return { key: `${orderNumber}-${name}-${group.index}`, name,
      quantity: group.lines.reduce((sum, line) => sum + line.quantity, 0),
      comparison: compareLinesToMarket(group.lines), intakeHistory };
  });
}

function SkuIntakeFigures({ history }: { history: ShippingIntakeLineHistory | null }) {
  if (!history) return <Typography variant="caption" color="text.secondary">—</Typography>;
  return <Stack spacing={0.25}>
    <Typography variant="caption">{history.priceKnownQuantity ? formatUsd(history.intakeMarketTotal ?? 0) : "Unavailable"}</Typography>
    <Typography variant="caption" color={history.status === "current" ? "text.secondary" : "warning.main"}>
      {history.priceKnownQuantity}/{history.orderedQuantity} priced · {history.weightedDaysHeld === null ? "age unavailable" : `${history.weightedDaysHeld.toFixed(1)} days`}
      {history.status === "current" ? "" : ` · ${history.status}`}
    </Typography>
  </Stack>;
}

function MarketFigure({
  label,
  comparison,
}: {
  label: string;
  comparison: MarketComparison;
}) {
  const coverage = describeMarketCoverage(comparison);

  return (
    <Box sx={{ minWidth: 96 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2">
        {comparison.comparableLineCount > 0
          ? formatUsd(comparison.comparableMarketTotal)
          : "Not available"}
      </Typography>
      {coverage && comparison.comparableLineCount > 0 && (
        <Typography variant="caption" color="warning.main">
          {coverage}
        </Typography>
      )}
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
  onBack: () => void;
  onContinue: () => void;
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
  onBack,
  onContinue,
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
  const shipmentComparison = compareOrdersToMarket(mergedOrders);

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
              <TableCell align="right">Sold</TableCell>
              <TableCell align="right">Current market</TableCell>
              <TableCell align="right">vs current market</TableCell>
              <TableCell>SKU intake market / age</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tableRows.map((row) => (
              <TableRow key={row.key}>
                <TableCell>{row.name}</TableCell>
                <TableCell align="right">{row.quantity}</TableCell>
                <TableCell align="right">
                  {row.comparison ? formatUsd(row.comparison.soldTotal) : "-"}
                </TableCell>
                <TableCell align="right">
                  {row.comparison && row.comparison.comparableLineCount > 0
                    ? formatUsd(row.comparison.comparableMarketTotal)
                    : "-"}
                </TableCell>
                <TableCell align="right">
                  {row.comparison ? <MarketDeltaChip comparison={row.comparison} /> : "-"}
                </TableCell>
                <TableCell><SkuIntakeFigures history={row.intakeHistory} /></TableCell>
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
    const orderLineItems = order.products ?? [];
    const histories = new Map((order.intakeHistory?.lines ?? []).map((line) => [line.skuId, line]));
    const fallbackRows =
      orderPullSheetItems.length > 0
        ? buildFallbackRowsFromPullSheet(order["Order #"], orderPullSheetItems, orderLineItems, histories)
        : buildFallbackRowsFromLines(order["Order #"], orderLineItems, histories);

    return {
      order,
      orderPullSheetItems,
      fallbackRows,
      comparison: compareOrderToMarket(order),
      priceBadgesBySku: buildPriceBadgesBySku(order),
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

                        <Box sx={{ minWidth: 96 }}>
                          <Typography variant="body2" color="text.secondary">
                            Value
                          </Typography>
                          <Typography variant="body2">
                            $
                            {mergedOrders
                              .reduce(
                                (sum, order) => sum + order["Value Of Products"],
                                0,
                              )
                              .toFixed(2)}
                          </Typography>
                        </Box>

                        <MarketFigure label="Current market" comparison={shipmentComparison} />

                        <Box sx={{ minWidth: 128 }}>
                          <Typography variant="body2" color="text.secondary">
                            vs current market
                          </Typography>
                          <Box sx={{ mt: 0.25 }}>
                            <MarketDeltaChip comparison={shipmentComparison} showAmount />
                          </Box>
                        </Box>

                        <Box sx={{ minWidth: 260, flex: "1 1 260px" }}>
                          <IntakeHistorySummary sourceOrders={mergedOrders} label="Shipment" compact />
                        </Box>

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
                            ({ order, orderPullSheetItems, comparison, priceBadgesBySku }) => (
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
                                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                                      <Chip
                                        label={`${order["Item Count"]} items`}
                                        size="small"
                                        variant="outlined"
                                      />
                                      <Chip
                                        label={`$${order["Value Of Products"].toFixed(2)}`}
                                        size="small"
                                        variant="outlined"
                                      />
                                      <MarketDeltaChip comparison={comparison} showAmount />
                                    </Stack>
                                  </Stack>
                                  <PullSheetGrid
                                    items={orderPullSheetItems}
                                    priceBadgesBySku={priceBadgesBySku}
                                  />
                                  <IntakeHistorySummary sourceOrders={[order]} label="Order" compact />
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
                          {orderSections.map(({ order, fallbackRows, comparison }) => (
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
                                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                                    <Chip
                                      label={`${order["Item Count"]} items`}
                                      size="small"
                                      variant="outlined"
                                    />
                                    <Chip
                                      label={`$${order["Value Of Products"].toFixed(2)}`}
                                      size="small"
                                      variant="outlined"
                                    />
                                    <MarketDeltaChip comparison={comparison} showAmount />
                                  </Stack>
                                </Stack>
                                {renderFallbackPullSheetTable(fallbackRows)}
                                <IntakeHistorySummary sourceOrders={[order]} label="Order" compact />
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
                <TableCell align="right">Value</TableCell>
                <TableCell>vs current market</TableCell>
                <TableCell>Intake history</TableCell>
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
                    <TableCell align="right">
                      {formatUsd(
                        rowOrders.reduce((sum, order) => sum + order["Value Of Products"], 0),
                      )}
                    </TableCell>
                    <TableCell>
                      <MarketDeltaChip comparison={compareOrdersToMarket(rowOrders)} />
                    </TableCell>
                    <TableCell sx={{ minWidth: 280 }}>
                      <IntakeHistorySummary sourceOrders={rowOrders} label="Shipment" compact />
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

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="contained"
          onClick={onContinue}
          disabled={packedCount === 0}
        >
          Continue to Apply Tracking
        </Button>
        {packedCount === 0 && (
          <Button
            variant="text"
            onClick={onContinue}
            size="small"
            color="inherit"
          >
            Skip (proceed anyway)
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
