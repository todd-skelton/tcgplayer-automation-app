import { Box, Paper, Stack, Typography } from "@mui/material";
import {
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  getMarketDeltaTone,
  type MarketDeltaTone,
} from "~/core/utils/marketDelta";
import {
  compareOrdersToMarket,
  describeMarketCoverage,
  describeMarketDelta,
  getMarketDeltaAmount,
  getMarketDeltaPercent,
} from "../services/orderMarketComparison";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

interface OrderMarketSummaryProps {
  sourceOrders: TcgPlayerShippingOrder[];
  shipmentCount: number;
}

const TONE_TEXT_COLORS: Record<MarketDeltaTone, string> = {
  above: "success.main",
  below: "error.main",
  at: "text.primary",
  unavailable: "text.secondary",
};

function SummaryMetric({
  label,
  value,
  detail,
  valueColor = "text.primary",
  detailColor = "text.secondary",
}: {
  label: string;
  value: string;
  detail: string;
  valueColor?: string;
  detailColor?: string;
}) {
  return (
    <Box sx={{ minWidth: 150, flex: "1 1 150px" }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="h6" component="div" color={valueColor} sx={{ lineHeight: 1.3 }}>
        {value}
      </Typography>
      <Typography variant="caption" component="div" color={detailColor}>
        {detail}
      </Typography>
    </Box>
  );
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One-line view of the whole order load against today's market. Stays visible
 * on every workflow step once orders are loaded.
 */
export function OrderMarketSummary({ sourceOrders, shipmentCount }: OrderMarketSummaryProps) {
  if (sourceOrders.length === 0) {
    return null;
  }

  const comparison = compareOrdersToMarket(sourceOrders);
  const deltaAmount = getMarketDeltaAmount(comparison);
  const deltaPercent = getMarketDeltaPercent(comparison);
  const tone = getMarketDeltaTone(deltaPercent);
  const coverage = describeMarketCoverage(comparison);
  const deltaValue =
    deltaAmount === null || deltaPercent === null
      ? "Not available"
      : `${formatSignedPercent(deltaPercent)} · ${formatSignedUsd(deltaAmount)}`;
  const marketDetail =
    coverage ??
    (comparison.lineCount > 0 ? "Every line has a market price" : "No line items to price");

  return (
    <Paper variant="outlined" sx={{ px: 2.5, py: 1.5, mb: 3 }}>
      <Stack
        direction="row"
        spacing={3}
        useFlexGap
        flexWrap="wrap"
        alignItems="flex-start"
        divider={
          <Box
            sx={{
              borderLeft: 1,
              borderColor: "divider",
              alignSelf: "stretch",
              display: { xs: "none", md: "block" },
            }}
          />
        }
      >
        <SummaryMetric
          label="Order load"
          value={pluralize(sourceOrders.length, "order")}
          detail={`${pluralize(shipmentCount, "shipment")} · ${pluralize(comparison.lineCount, "line")}`}
        />
        <SummaryMetric
          label="Sold"
          value={formatUsd(comparison.soldTotal)}
          detail="Product value, before shipping"
        />
        <SummaryMetric
          label="Market"
          value={formatUsd(comparison.comparableMarketTotal)}
          detail={marketDetail}
          detailColor={coverage ? "warning.main" : "text.secondary"}
        />
        <SummaryMetric
          label="Sold vs market"
          value={deltaValue}
          valueColor={TONE_TEXT_COLORS[tone]}
          detail={describeMarketDelta(comparison)}
          detailColor={TONE_TEXT_COLORS[tone]}
        />
      </Stack>
    </Paper>
  );
}
