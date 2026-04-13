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
      : sourceOrders.map((o) => o["Order #"]);

  const totalShipments = shipmentReferences.length;
  const currentReference = shipmentReferences[currentIndex] ?? null;

  const currentOrder =
    sourceOrders.find((o) => o["Order #"] === currentReference) ?? null;

  const mergedOrderNumbers = currentReference
    ? (shipmentToOrderMap[currentReference] ?? [currentReference])
    : [];
  const mergedOrders = mergedOrderNumbers
    .map((num) => sourceOrders.find((o) => o["Order #"] === num))
    .filter((o): o is TcgPlayerShippingOrder => o !== null);

  const purchaseEntry = currentReference
    ? outboundPurchaseResultsByReference[currentReference]
    : null;
  const isPacked = currentReference
    ? packedOrderNumbers.has(currentReference)
    : false;
  const packedCount = packedOrderNumbers.size;
  const progress = totalShipments > 0 ? (packedCount / totalShipments) * 100 : 0;

  const allLineItems = mergedOrders.flatMap((o) => o.products ?? []);
  const hasLineItems = allLineItems.length > 0;

  const aggregatedItems = allLineItems.reduce<Map<string, number>>((map, item) => {
    map.set(item.name, (map.get(item.name) ?? 0) + item.quantity);
    return map;
  }, new Map());

  function handleMarkPacked(reference: string, packed: boolean) {
    onOrderPacked(reference, packed);
    if (packed) {
      const nextUnpacked = shipmentReferences.findIndex(
        (ref, i) => i > currentIndex && !packedOrderNumbers.has(ref)
      );
      if (nextUnpacked !== -1) {
        setCurrentIndex(nextUnpacked);
      } else {
        const firstUnpacked = shipmentReferences.findIndex(
          (ref) => ref !== reference && !packedOrderNumbers.has(ref)
        );
        if (firstUnpacked !== -1) {
          setCurrentIndex(firstUnpacked);
        }
      }
    }
  }

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
        <Stack direction="row" spacing={1} alignItems="center">
          {viewMode === "card" && (
            <>
              <IconButton
                onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                disabled={currentIndex === 0}
              >
                <ChevronLeftIcon />
              </IconButton>
              <Typography variant="body1" fontWeight={600}>
                Shipment {currentIndex + 1} of {totalShipments}
              </Typography>
              <IconButton
                onClick={() =>
                  setCurrentIndex((i) => Math.min(totalShipments - 1, i + 1))
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
            onChange={(_, v) => v && setViewMode(v)}
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
                <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
                  <Stack spacing={1.5} flex={1}>
                    <Typography variant="subtitle1" fontWeight={600}>
                      Order Details
                    </Typography>

                    {mergedOrderNumbers.length > 1 && (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap">
                        {mergedOrderNumbers.map((num) => (
                          <Chip key={num} label={num} size="small" variant="outlined" />
                        ))}
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ alignSelf: "center" }}
                        >
                          (combined shipment)
                        </Typography>
                      </Stack>
                    )}
                    {mergedOrderNumbers.length === 1 && (
                      <Typography variant="body2" fontWeight={500}>
                        {currentReference}
                      </Typography>
                    )}

                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        Recipient
                      </Typography>
                      <Typography variant="body2">
                        {currentOrder.FirstName} {currentOrder.LastName}
                      </Typography>
                    </Box>

                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        Address
                      </Typography>
                      <Typography
                        variant="body2"
                        component="pre"
                        sx={{ fontFamily: "inherit" }}
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

                    <Stack direction="row" spacing={2}>
                      <Box>
                        <Typography variant="body2" color="text.secondary">
                          Items
                        </Typography>
                        <Typography variant="body2">
                          {mergedOrders.reduce((s, o) => s + o["Item Count"], 0)}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="body2" color="text.secondary">
                          Value
                        </Typography>
                        <Typography variant="body2">
                          $
                          {mergedOrders
                            .reduce((s, o) => s + o["Value Of Products"], 0)
                            .toFixed(2)}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="body2" color="text.secondary">
                          Method
                        </Typography>
                        <Typography variant="body2">
                          {currentOrder["Shipping Method"]}
                        </Typography>
                      </Box>
                    </Stack>

                    {purchaseEntry && (
                      <Box>
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

                    <FormControlLabel
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
                  </Stack>

                  <Stack spacing={1.5} flex={1}>
                    <Typography variant="subtitle1" fontWeight={600}>
                      Pull Sheet
                    </Typography>

                    {!hasLineItems && (
                      <Alert severity="info">
                        Line item details unavailable — refer to the packing slip PDF.
                      </Alert>
                    )}

                    {hasLineItems && (
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
                <TableCell>Postage</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shipmentReferences.map((ref, idx) => {
                const orderNums = shipmentToOrderMap[ref] ?? [ref];
                const primaryOrder =
                  sourceOrders.find((o) => o["Order #"] === ref) ?? null;
                const rowOrders = orderNums
                  .map((num) => sourceOrders.find((o) => o["Order #"] === num))
                  .filter((o): o is TcgPlayerShippingOrder => o !== null);
                const purchase = outboundPurchaseResultsByReference[ref];
                const packed = packedOrderNumbers.has(ref);

                return (
                  <TableRow
                    key={ref}
                    selected={idx === currentIndex}
                    hover
                    onClick={() => setCurrentIndex(idx)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={packed}
                        onChange={(e) => {
                          e.stopPropagation();
                          handleMarkPacked(ref, e.target.checked);
                        }}
                        color="success"
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      {orderNums.length > 1 ? (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap">
                          {orderNums.map((n) => (
                            <Chip key={n} label={n} size="small" variant="outlined" />
                          ))}
                        </Stack>
                      ) : (
                        <Typography variant="body2">{ref}</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {primaryOrder
                        ? `${primaryOrder.FirstName} ${primaryOrder.LastName}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {primaryOrder?.["Shipping Method"] ?? "—"}
                    </TableCell>
                    <TableCell align="right">
                      {rowOrders.reduce((s, o) => s + o["Item Count"], 0)}
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
                        "—"
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
