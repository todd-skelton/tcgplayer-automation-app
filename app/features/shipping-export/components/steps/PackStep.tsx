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
import { PullSheetGrid } from "~/features/pull-sheet/components/PullSheetGrid";
import type {
  PackPullSheetLoadStatus,
  PackPullSheetShipmentMatch,
} from "../../services/packPullSheet";
import type {
  EasyPostMode,
  ShipmentToOrderMap,
  ShippingPostagePurchaseResult,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";

type PurchaseEntry = {
  mode: EasyPostMode;
  result: ShippingPostagePurchaseResult;
};

interface PackStepProps {
  sourceOrders: TcgPlayerShippingOrder[];
  shipmentToOrderMap: ShipmentToOrderMap;
  outboundPurchaseResultsByReference: Record<string, PurchaseEntry>;
  packPullSheetStatus: PackPullSheetLoadStatus;
  packPullSheetError: string | null;
  packPullSheetMatchesByReference: Record<string, PackPullSheetShipmentMatch>;
  packedOrderNumbers: Set<string>;
  onOrderPacked: (reference: string, packed: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
}

type ViewMode = "card" | "list";

export function PackStep({
  sourceOrders,
  shipmentToOrderMap,
  outboundPurchaseResultsByReference,
  packPullSheetStatus,
  packPullSheetError,
  packPullSheetMatchesByReference,
  packedOrderNumbers,
  onOrderPacked,
  onBack,
  onContinue,
}: PackStepProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("card");

  const shipmentReferences =
    Object.keys(shipmentToOrderMap).length > 0
      ? Object.keys(shipmentToOrderMap)
      : sourceOrders.map((order) => order["Order #"]);

  const totalShipments = shipmentReferences.length;
  const currentReference = shipmentReferences[currentIndex] ?? null;
  const currentOrder =
    sourceOrders.find((order) => order["Order #"] === currentReference) ?? null;

  const mergedOrderNumbers = currentReference
    ? (shipmentToOrderMap[currentReference] ?? [currentReference])
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

  const aggregatedItems = allLineItems.reduce<Map<string, number>>((map, item) => {
    map.set(item.name, (map.get(item.name) ?? 0) + item.quantity);
    return map;
  }, new Map());

  function renderSimplePullSheetTable() {
    return (
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Card</TableCell>
              <TableCell align="right">Qty</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {[...aggregatedItems.entries()].map(([name, qty]) => (
              <TableRow key={name}>
                <TableCell>{name}</TableCell>
                <TableCell align="right">{qty}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  }

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
                          Order Details
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
                        <Box>
                          <PullSheetGrid items={visualPullSheetMatch.items} />
                        </Box>
                      )}

                    {hasLineItems &&
                      packPullSheetStatus !== "loading" &&
                      (!visualPullSheetMatch?.canRenderGrid ||
                        packPullSheetStatus === "error") &&
                      renderSimplePullSheetTable()}
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
                <TableCell>Postage</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shipmentReferences.map((shipmentReference, index) => {
                const orderNumbers = shipmentToOrderMap[shipmentReference] ?? [shipmentReference];
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
