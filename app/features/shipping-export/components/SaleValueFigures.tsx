import { Box, Tooltip } from "@mui/material";
import type { ReactNode } from "react";
import {
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  getMarketDeltaTone,
  type MarketDeltaTone,
} from "~/core/utils/marketDelta";
import type { SaleComparison, SaleValue } from "../services/saleValue";

const TONE_COLORS: Record<MarketDeltaTone, string> = {
  above: "success.main",
  below: "error.main",
  at: "inherit",
  unavailable: "inherit",
};

/** Lighter tones that stay readable over card art. */
const ON_IMAGE_TONE_COLORS: Record<MarketDeltaTone, string> = {
  above: "#a5d6a7",
  below: "#ef9a9a",
  at: "inherit",
  unavailable: "inherit",
};

function Figure({ label, partial, children }: { label: string; partial: string | null; children: ReactNode }) {
  const figure = (
    <Box sx={{ whiteSpace: "nowrap" }}>
      <Box component="dt" sx={{ display: "inline", opacity: 0.7, mr: 0.5 }}>
        {label}
      </Box>
      <Box component="dd" sx={{ display: "inline", m: 0 }}>
        {children}
        {partial && "*"}
      </Box>
    </Box>
  );

  return partial ? <Tooltip title={`Partial: ${partial}. The difference compares only those.`}>{figure}</Tooltip> : figure;
}

function Comparison({ comparison, onImage }: { comparison: SaleComparison | null; onImage: boolean }) {
  if (!comparison) return <>-</>;
  const tone = getMarketDeltaTone(comparison.percent);
  const colors = onImage ? ON_IMAGE_TONE_COLORS : TONE_COLORS;

  return (
    <>
      {formatUsd(comparison.total)}{" "}
      <Box component="span" sx={{ color: colors[tone], fontWeight: 600 }}>
        {formatSignedUsd(comparison.difference)}
        {comparison.percent === null ? "" : ` ${formatSignedPercent(comparison.percent)}`}
      </Box>
    </>
  );
}

/**
 * Price, current market, intake market, and age for a card, order, or batch.
 * Differences are the price minus that value: green when sold above it, red below.
 */
export function SaleValueFigures({
  value,
  variant = "body2",
  onImage = false,
}: {
  value: SaleValue;
  variant?: "body2" | "caption";
  /** Set when drawn over card art, which needs lighter colors. */
  onImage?: boolean;
}) {
  return (
    <Box
      component="dl"
      sx={{ display: "flex", flexWrap: "wrap", columnGap: 1.5, rowGap: 0.25, m: 0, typography: variant }}
    >
      <Figure label="Price" partial={null}>
        {formatUsd(value.price)}
      </Figure>
      <Figure label="Market" partial={value.market?.partial ?? null}>
        <Comparison comparison={value.market} onImage={onImage} />
      </Figure>
      <Figure label="Intake" partial={value.intake?.partial ?? null}>
        <Comparison comparison={value.intake} onImage={onImage} />
      </Figure>
      <Figure label="Age" partial={value.agePartial}>
        {value.ageDays === null ? "-" : `${value.ageDays.toFixed(1)}d`}
      </Figure>
    </Box>
  );
}
