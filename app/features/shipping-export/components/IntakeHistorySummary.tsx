import { Box, Chip, Divider, Stack, Typography } from "@mui/material";
import { compareOrdersToIntake, intakeDeltaAmount, intakeDeltaPercent } from "../services/orderIntakeComparison";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

function usd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function days(value: number | null) {
  return value === null ? "Unavailable" : `${value.toFixed(1)} days`;
}

function coverage(known: number, total: number) {
  return `${known} of ${total} units`;
}

function sourceLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function IntakeHistorySummary({
  sourceOrders,
  label = "Order",
  compact = false,
}: {
  sourceOrders: TcgPlayerShippingOrder[];
  label?: string;
  compact?: boolean;
}) {
  if (!sourceOrders.length) return null;
  const comparison = compareOrdersToIntake(sourceOrders);
  const delta = intakeDeltaAmount(comparison);
  const percent = intakeDeltaPercent(comparison);
  const uniqueOrders = [...new Map(sourceOrders.map((order) => [order["Order #"], order])).values()];
  const reviewCount = comparison.heldLineCount + comparison.mismatchLineCount;

  return (
    <Stack spacing={compact ? 0.5 : 1} sx={{ minWidth: 0 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.25, sm: 2 }} useFlexGap flexWrap="wrap">
        <Typography variant={compact ? "caption" : "body2"}>
          <strong>{label} intake market:</strong>{" "}
          {comparison.priceKnownQuantity ? usd(comparison.intakeMarketTotal) : "Unavailable"}
        </Typography>
        <Typography variant={compact ? "caption" : "body2"}>
          <strong>Sold vs intake market:</strong>{" "}
          {delta === null ? "Unavailable" : `${delta >= 0 ? "+" : ""}${usd(delta)}${percent === null ? "" : ` (${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%)`}`}
        </Typography>
        <Typography variant={compact ? "caption" : "body2"}>
          <strong>Age at sale:</strong> {days(comparison.weightedDaysHeld)}
          {comparison.minimumDaysHeld !== null && comparison.maximumDaysHeld !== null
            && comparison.minimumDaysHeld !== comparison.maximumDaysHeld
            ? ` (${comparison.minimumDaysHeld.toFixed(1)}–${comparison.maximumDaysHeld.toFixed(1)} day range)` : ""}
        </Typography>
      </Stack>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        <Chip size="small" variant="outlined" label={`Matched ${coverage(comparison.matchedQuantity, comparison.orderedQuantity)}`} />
        <Chip size="small" variant="outlined" label={`Intake price ${coverage(comparison.priceKnownQuantity, comparison.orderedQuantity)}`} />
        <Chip size="small" variant="outlined" label={`Intake date ${coverage(comparison.dateKnownQuantity, comparison.orderedQuantity)}`} />
        {comparison.estimatedPriceQuantity > 0 && <Chip size="small" color="warning" variant="outlined" label={`${comparison.estimatedPriceQuantity} estimated price units`} />}
        {comparison.pendingLineCount > 0 && <Chip size="small" color="info" variant="outlined" label={`${comparison.pendingLineCount} allocation ${comparison.pendingLineCount === 1 ? "line" : "lines"} pending`} />}
        {comparison.unavailableLineCount > 0 && <Chip size="small" variant="outlined" label={`${comparison.unavailableLineCount} history ${comparison.unavailableLineCount === 1 ? "line" : "lines"} unavailable`} />}
        {reviewCount > 0 && <Chip size="small" color="warning" label={`${reviewCount} history ${reviewCount === 1 ? "line needs" : "lines need"} review`} />}
      </Stack>
      <Box component="details" sx={{ maxWidth: "100%" }}>
        <Box component="summary" sx={{ cursor: "pointer", color: "text.secondary", typography: "caption" }}>
          Receipt lots and history status ({comparison.lotCount})
        </Box>
        <Stack spacing={1} sx={{ mt: 1, pl: 1 }} divider={<Divider flexItem />}>
          {uniqueOrders.flatMap((order) => (order.intakeHistory?.lines ?? []).map((line) => (
            <Box key={`${order["Order #"]}:${line.skuId}`}>
              <Typography variant="caption" component="div">
                Order {order["Order #"]} · SKU {line.skuId} · {line.status}
                {line.statusReason ? ` — ${line.statusReason}` : ""}
              </Typography>
              {line.lots.map((lot) => (
                <Typography key={lot.supplyKey} variant="caption" color="text.secondary" component="div">
                  Receipt {lot.receiptId}: {lot.quantity} {lot.quantity === 1 ? "unit" : "units"} · {sourceLabel(lot.sourceKind)} ·
                  {" "}available {new Date(lot.availableAt).toLocaleDateString()} · intake {lot.intakeAt ? new Date(lot.intakeAt).toLocaleDateString() : "unknown"} ·
                  {" "}market {lot.intakeMarketValue === null ? "unknown" : `${usd(lot.intakeMarketValue)} (${lot.priceProvenance})`} · age {days(lot.daysHeld)}
                </Typography>
              ))}
              {!line.lots.length && <Typography variant="caption" color="text.secondary">No current receipt allocation detail.</Typography>}
            </Box>
          )))}
        </Stack>
      </Box>
    </Stack>
  );
}
