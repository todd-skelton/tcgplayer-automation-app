import { Chip, Tooltip } from "@mui/material";
import {
  formatSignedPercent,
  formatSignedUsd,
  getMarketDeltaTone,
  type MarketDeltaTone,
} from "~/core/utils/marketDelta";
import {
  describeMarketCoverage,
  describeMarketDelta,
  getMarketDeltaAmount,
  getMarketDeltaPercent,
  type MarketComparison,
} from "../services/orderMarketComparison";

interface MarketDeltaChipProps {
  comparison: MarketComparison;
  /** Append the dollar delta after the percentage. */
  showAmount?: boolean;
  /** Render nothing instead of a "No market" chip when no line could be compared. */
  hideWhenUnavailable?: boolean;
}

const TONE_COLORS: Record<MarketDeltaTone, "success" | "error" | "default"> = {
  above: "success",
  below: "error",
  at: "default",
  unavailable: "default",
};

/**
 * Sold-versus-market chip using the app's convention: positive means above
 * market and shows green, negative means below market and shows red.
 */
export function MarketDeltaChip({
  comparison,
  showAmount = false,
  hideWhenUnavailable = false,
}: MarketDeltaChipProps) {
  const percent = getMarketDeltaPercent(comparison);
  const amount = getMarketDeltaAmount(comparison);
  const tone = getMarketDeltaTone(percent);

  if (percent === null || amount === null) {
    if (hideWhenUnavailable) {
      return null;
    }

    return (
      <Tooltip title="No market price was available for these lines.">
        <Chip label="No market" size="small" variant="outlined" />
      </Tooltip>
    );
  }

  const label = showAmount
    ? `${formatSignedPercent(percent)} (${formatSignedUsd(amount)})`
    : formatSignedPercent(percent);
  const coverage = describeMarketCoverage(comparison);
  const title = coverage
    ? `${describeMarketDelta(comparison)} · ${coverage}`
    : describeMarketDelta(comparison);

  return (
    <Tooltip title={title}>
      <Chip
        label={label}
        size="small"
        variant="outlined"
        color={TONE_COLORS[tone]}
        aria-label={`Sold versus market: ${title}`}
      />
    </Tooltip>
  );
}
