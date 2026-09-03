import { alpha } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import {
  Box,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { getConditionColor } from "~/core/utils/conditionColors";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import type { ProductPriceMatrixResponse } from "../types/productPriceMatrix";
import {
  formatPercentileLabel,
  getAvailablePercentiles,
  getConfiguredPercentiles,
} from "./percentileColumns";

const VARIANT_COLUMN_WIDTH = 150;
const CONDITION_COLUMN_WIDTH = 150;
const MARKET_COLUMN_WIDTH = 110;

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatDays(value: number | undefined): string {
  if (value === undefined) {
    return "N/A";
  }

  if (value < 1) {
    return "<1 day";
  }

  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} days`;
}

function getMarketDelta(
  marketPrice: number | null,
  suggestedPrice: number | null,
): number | null {
  if (marketPrice === null || marketPrice === 0 || suggestedPrice === null) {
    return null;
  }

  return ((suggestedPrice - marketPrice) / marketPrice) * 100;
}

type MatrixConditionColor = Exclude<
  ReturnType<typeof getConditionColor>,
  "default"
>;

function getMatrixConditionColor(
  condition: Condition,
): MatrixConditionColor | null {
  const color = getConditionColor(condition);
  return color === "default" ? null : color;
}

function getConditionAccentColor(condition: Condition): string {
  const color = getMatrixConditionColor(condition);
  return color === null ? "divider" : `${color}.main`;
}

function getConditionTintStyles(
  condition: Condition,
  theme: Theme,
  opacity: number,
): { backgroundColor: string; backgroundImage: string } {
  const color = getMatrixConditionColor(condition);
  const tint =
    color === null
      ? alpha(theme.palette.text.primary, opacity * 0.5)
      : alpha(theme.palette[color].main, opacity);

  return {
    backgroundColor: theme.palette.background.paper,
    backgroundImage: `linear-gradient(${tint}, ${tint})`,
  };
}

export function ProductPriceMatrixTable({
  matrix,
}: {
  matrix: ProductPriceMatrixResponse;
}) {
  const availablePercentiles = getAvailablePercentiles(matrix.cells);
  const configuredPercentiles = getConfiguredPercentiles(matrix.cells);
  const hasPercentileColumns = availablePercentiles.length > 0;
  const headerRowSpan = hasPercentileColumns ? 2 : 1;

  return (
    <TableContainer component={Box} sx={{ overflowX: "auto" }}>
      <Table
        size="small"
        aria-label="Product prices by condition, variant, and percentile"
        sx={{
          minWidth: hasPercentileColumns
            ? 940 + availablePercentiles.length * 130
            : 1150,
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell
              rowSpan={headerRowSpan}
              sx={{
                fontWeight: 700,
                position: "sticky",
                left: 0,
                bgcolor: "background.paper",
                zIndex: 3,
                width: VARIANT_COLUMN_WIDTH,
                minWidth: VARIANT_COLUMN_WIDTH,
                maxWidth: VARIANT_COLUMN_WIDTH,
              }}
            >
              Variant
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              sx={{
                fontWeight: 700,
                position: "sticky",
                left: VARIANT_COLUMN_WIDTH,
                bgcolor: "background.paper",
                zIndex: 3,
                width: CONDITION_COLUMN_WIDTH,
                minWidth: CONDITION_COLUMN_WIDTH,
                maxWidth: CONDITION_COLUMN_WIDTH,
              }}
            >
              Condition
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              align="right"
              sx={{
                fontWeight: 700,
                position: "sticky",
                left: VARIANT_COLUMN_WIDTH + CONDITION_COLUMN_WIDTH,
                bgcolor: "background.paper",
                borderRight: "1px solid",
                borderRightColor: "divider",
                zIndex: 3,
                width: MARKET_COLUMN_WIDTH,
                minWidth: MARKET_COLUMN_WIDTH,
                maxWidth: MARKET_COLUMN_WIDTH,
              }}
            >
              Market
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              align="right"
              sx={{ fontWeight: 700, minWidth: 100 }}
            >
              Low
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              align="right"
              sx={{ fontWeight: 700, minWidth: 100 }}
            >
              High
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              align="right"
              sx={{ fontWeight: 700, minWidth: 80 }}
            >
              Sales
            </TableCell>
            {hasPercentileColumns ? (
              <TableCell
                align="center"
                colSpan={availablePercentiles.length}
                sx={{
                  fontWeight: 700,
                  borderLeft: "1px solid",
                  borderLeftColor: "divider",
                }}
              >
                Suggested price by percentile
              </TableCell>
            ) : (
              <TableCell align="center" sx={{ fontWeight: 700, minWidth: 210 }}>
                Suggested pricing
              </TableCell>
            )}
            <TableCell
              rowSpan={headerRowSpan}
              align="right"
              sx={{ fontWeight: 700, minWidth: 145 }}
            >
              Selection
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              align="right"
              sx={{ fontWeight: 700, minWidth: 130 }}
            >
              Marketplace
            </TableCell>
            <TableCell
              rowSpan={headerRowSpan}
              sx={{ fontWeight: 700, minWidth: 120 }}
            >
              Notes
            </TableCell>
          </TableRow>
          {hasPercentileColumns && (
            <TableRow>
              {availablePercentiles.map((percentile) => {
                const isConfigured = configuredPercentiles.includes(percentile);

                return (
                  <TableCell
                    key={percentile}
                    align="right"
                    sx={{
                      minWidth: 130,
                      borderLeft: "1px solid",
                      borderLeftColor: "divider",
                      bgcolor: isConfigured ? "action.selected" : undefined,
                    }}
                  >
                    <Stack spacing={0.25} alignItems="flex-end">
                      <Typography
                        variant="body2"
                        component="span"
                        fontWeight={700}
                        color={isConfigured ? "primary.main" : "inherit"}
                      >
                        {formatPercentileLabel(percentile)}
                        {isConfigured ? " ★" : ""}
                      </Typography>
                      <Typography
                        variant="caption"
                        component="span"
                        color="text.secondary"
                      >
                        Price · expected time
                      </Typography>
                    </Stack>
                  </TableCell>
                );
              })}
            </TableRow>
          )}
        </TableHead>
        <TableBody>
          {matrix.cells.map((cell, index) => {
            const hasWarnings = cell.warnings.length > 0;
            const hasErrors = cell.errors.length > 0;
            const conditionColor = getConditionColor(cell.condition);
            const startsVariantGroup =
              index === 0 || matrix.cells[index - 1]?.variant !== cell.variant;
            const groupBorder = startsVariantGroup ? "2px solid" : undefined;

            return (
              <TableRow
                key={cell.sku}
                sx={(theme) => ({
                  "&:hover td, &:hover th": {
                    ...getConditionTintStyles(
                      cell.condition,
                      theme,
                      theme.palette.mode === "dark" ? 0.2 : 0.1,
                    ),
                  },
                })}
              >
                <TableCell
                  component="th"
                  scope="row"
                  sx={(theme) => ({
                    fontWeight: 700,
                    position: "sticky",
                    left: 0,
                    ...getConditionTintStyles(
                      cell.condition,
                      theme,
                      theme.palette.mode === "dark" ? 0.16 : 0.06,
                    ),
                    zIndex: 1,
                    width: VARIANT_COLUMN_WIDTH,
                    minWidth: VARIANT_COLUMN_WIDTH,
                    maxWidth: VARIANT_COLUMN_WIDTH,
                    whiteSpace: "nowrap",
                    borderLeft: "4px solid",
                    borderLeftColor: getConditionAccentColor(cell.condition),
                    borderTop: groupBorder,
                    borderTopColor: "divider",
                  })}
                >
                  {cell.variant}
                </TableCell>
                <TableCell
                  sx={(theme) => ({
                    whiteSpace: "nowrap",
                    position: "sticky",
                    left: VARIANT_COLUMN_WIDTH,
                    zIndex: 1,
                    width: CONDITION_COLUMN_WIDTH,
                    minWidth: CONDITION_COLUMN_WIDTH,
                    maxWidth: CONDITION_COLUMN_WIDTH,
                    ...getConditionTintStyles(
                      cell.condition,
                      theme,
                      theme.palette.mode === "dark" ? 0.16 : 0.06,
                    ),
                    borderTop: groupBorder,
                    borderTopColor: "divider",
                  })}
                >
                  <Chip
                    color={conditionColor}
                    label={cell.condition}
                    size="small"
                    variant="outlined"
                    sx={{
                      fontWeight: 700,
                      minWidth: 122,
                      justifyContent: "flex-start",
                    }}
                  />
                </TableCell>
                <TableCell
                  align="right"
                  sx={{
                    fontWeight: 700,
                    position: "sticky",
                    left: VARIANT_COLUMN_WIDTH + CONDITION_COLUMN_WIDTH,
                    zIndex: 1,
                    width: MARKET_COLUMN_WIDTH,
                    minWidth: MARKET_COLUMN_WIDTH,
                    maxWidth: MARKET_COLUMN_WIDTH,
                    bgcolor: "background.paper",
                    borderRight: "1px solid",
                    borderRightColor: "divider",
                    borderTop: groupBorder,
                    borderTopColor: "divider",
                  }}
                >
                  {formatCurrency(cell.tcgMarketPrice)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ borderTop: groupBorder, borderTopColor: "divider" }}
                >
                  {formatCurrency(cell.lowestSalePrice)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ borderTop: groupBorder, borderTopColor: "divider" }}
                >
                  {formatCurrency(cell.highestSalePrice)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ borderTop: groupBorder, borderTopColor: "divider" }}
                >
                  {cell.saleCount.toLocaleString()}
                </TableCell>
                {hasPercentileColumns ? (
                  availablePercentiles.map((percentile) => {
                    const detail = cell.percentiles?.find(
                      (candidate) => candidate.percentile === percentile,
                    );
                    const isConfigured = cell.percentileUsed === percentile;
                    const marketDelta = isConfigured
                      ? getMarketDelta(
                          cell.tcgMarketPrice,
                          detail?.suggestedPrice ?? null,
                        )
                      : null;

                    return (
                      <TableCell
                        key={percentile}
                        align="right"
                        aria-label={`${formatPercentileLabel(
                          percentile,
                        )} percentile: ${formatCurrency(
                          detail?.suggestedPrice,
                        )}, ${formatDays(detail?.estimatedTimeToSellDays)}${
                          isConfigured ? ", configured percentile" : ""
                        }`}
                        sx={(theme) => ({
                          minWidth: 130,
                          ...(isConfigured
                            ? getConditionTintStyles(
                                cell.condition,
                                theme,
                                theme.palette.mode === "dark" ? 0.24 : 0.1,
                              )
                            : {}),
                          borderLeft: "1px solid",
                          borderLeftColor: isConfigured
                            ? getConditionAccentColor(cell.condition)
                            : "divider",
                          borderTop: groupBorder,
                          borderTopColor: "divider",
                        })}
                      >
                        <Stack spacing={0.25} alignItems="flex-end">
                          <Stack
                            direction="row"
                            spacing={0.75}
                            alignItems="center"
                            justifyContent="flex-end"
                            flexWrap="nowrap"
                          >
                            {marketDelta !== null && (
                              <Chip
                                size="small"
                                variant="outlined"
                                label={`${marketDelta >= 0 ? "+" : ""}${marketDelta.toFixed(0)}%`}
                                color={marketDelta >= 0 ? "success" : "default"}
                              />
                            )}
                            <Typography
                              variant="body2"
                              component="span"
                              fontWeight={700}
                            >
                              {formatCurrency(detail?.suggestedPrice)}
                            </Typography>
                          </Stack>
                          <Typography
                            variant="caption"
                            component="span"
                            color="text.secondary"
                          >
                            {formatDays(detail?.estimatedTimeToSellDays)}
                          </Typography>
                        </Stack>
                      </TableCell>
                    );
                  })
                ) : (
                  <TableCell
                    align="center"
                    sx={{
                      color: "text.secondary",
                      borderTop: groupBorder,
                      borderTopColor: "divider",
                    }}
                  >
                    Run Suggested Pricing to compare percentiles
                  </TableCell>
                )}
                <TableCell
                  align="right"
                  sx={{ borderTop: groupBorder, borderTopColor: "divider" }}
                >
                  {cell.pricingDecision ? (
                    <Stack spacing={0.25} alignItems="flex-end">
                      <Typography variant="body2" fontWeight={700}>
                        {cell.pricingDecision.method === "percentile"
                          ? `${cell.pricingDecision.configuredPercentile ?? cell.percentileUsed}th percentile`
                          : cell.pricingDecision.method === "target-horizon"
                            ? `${formatDays(cell.pricingDecision.targetHorizonDays)} target`
                            : `${((cell.pricingDecision.dailyReturnHurdle ?? 0) * 100).toFixed(2)}%/day hurdle`}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {cell.pricingDecision.basis.replaceAll("-", " ")}
                        {cell.pricingDecision.unprofitable
                          ? ", below overhead"
                          : ""}
                      </Typography>
                      {cell.pricingDecision.equivalentPercentile !==
                        undefined &&
                        cell.pricingDecision.method !== "percentile" && (
                          <Typography variant="caption" color="text.secondary">
                            ≈{" "}
                            {cell.pricingDecision.equivalentPercentile.toFixed(
                              1,
                            )}
                            th
                          </Typography>
                        )}
                      {cell.pricingDecision.constraint !== "none" && (
                        <Typography variant="caption" color="warning.main">
                          {cell.pricingDecision.constraint.replaceAll("-", " ")}
                        </Typography>
                      )}
                    </Stack>
                  ) : (
                    "N/A"
                  )}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ borderTop: groupBorder, borderTopColor: "divider" }}
                >
                  {formatCurrency(cell.marketplacePrice)}
                </TableCell>
                <TableCell
                  sx={{ borderTop: groupBorder, borderTopColor: "divider" }}
                >
                  <Stack direction="row" spacing={0.5} flexWrap="wrap">
                    {hasWarnings && (
                      <Tooltip title={cell.warnings.join(" ")}>
                        <Chip size="small" color="warning" label="Warning" />
                      </Tooltip>
                    )}
                    {hasErrors && (
                      <Tooltip title={cell.errors.join(" ")}>
                        <Chip size="small" color="error" label="Error" />
                      </Tooltip>
                    )}
                  </Stack>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
