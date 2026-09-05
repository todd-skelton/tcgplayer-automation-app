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
  Typography,
} from "@mui/material";
import { getConditionColor } from "~/core/utils/conditionColors";
import {
  formatOptionalUsd,
  formatSignedPercent,
  getMarketDeltaTone,
  percentAboveMarket,
  type MarketDeltaTone,
} from "~/core/utils/marketDelta";
import {
  describeDecisionBasis,
  describeDecisionRule,
  formatDays,
  formatPercentile,
  policyMethodLabel,
} from "~/features/pricing/components/policyLabel";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import { ConditionNotes } from "./ConditionNotes";
import type {
  ProductPriceMatrixCell,
  ProductPriceMatrixResponse,
} from "../types/productPriceMatrix";

const VARIANT_COLUMN_WIDTH = 150;
const CONDITION_COLUMN_WIDTH = 150;
const MARKET_COLUMN_WIDTH = 110;

const DELTA_COLORS: Record<MarketDeltaTone, "success" | "error" | "default"> = {
  above: "success",
  below: "error",
  at: "default",
  unavailable: "default",
};

const STICKY_HEADER = {
  fontWeight: 700,
  position: "sticky" as const,
  bgcolor: "background.paper",
  zIndex: 3,
};

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

function MarketDelta({
  price,
  market,
}: {
  price: number | null;
  market: number | null;
}) {
  const percent = price === null ? null : percentAboveMarket(price, market);
  if (percent === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }
  const tone = getMarketDeltaTone(percent);
  return (
    <Chip
      size="small"
      variant="outlined"
      color={DELTA_COLORS[tone]}
      label={formatSignedPercent(percent)}
      aria-label={`Sell-at versus market: ${formatSignedPercent(percent)}`}
    />
  );
}

function ListingCell({ cell }: { cell: ProductPriceMatrixCell }) {
  if (!cell.listing) {
    return (
      <Typography variant="body2" color="text.secondary">
        Not listed
      </Typography>
    );
  }
  const { price, quantity, inStock } = cell.listing;
  return (
    <Stack spacing={0.25} alignItems="flex-end">
      <Typography variant="body2" fontWeight={700}>
        {formatOptionalUsd(price)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {inStock && quantity > 0 ? `${quantity} in stock` : "Out of stock"}
      </Typography>
    </Stack>
  );
}

function SellAtCell({
  cell,
  priced,
}: {
  cell: ProductPriceMatrixCell;
  priced: boolean;
}) {
  const decision = cell.pricingDecision;
  if (cell.sellAtPrice === null || !decision) {
    return (
      <Typography variant="body2" color="text.secondary">
        {cell.errors.length > 0 ? "Failed" : priced ? "No price" : "Not priced"}
      </Typography>
    );
  }
  const equivalent =
    decision.equivalentPercentile === undefined
      ? ""
      : ` · ≈${formatPercentile(decision.equivalentPercentile)}`;
  return (
    <Stack spacing={0.25} alignItems="flex-end">
      <Typography variant="body2" fontWeight={700}>
        {formatOptionalUsd(cell.sellAtPrice)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {decision.basis === "modeled"
          ? `${formatDays(cell.estimatedTimeToSellDays)}${equivalent}`
          : describeDecisionBasis(decision)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {describeDecisionRule(decision)}
        {decision.constraint !== "none"
          ? ` · ${decision.constraint.replaceAll("-", " ")}`
          : ""}
        {decision.unprofitable ? " · below overhead" : ""}
      </Typography>
    </Stack>
  );
}

function ShadowCell({ cell }: { cell: ProductPriceMatrixCell }) {
  const shadow = cell.shadowPricingDecision;
  if (!shadow) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }
  return (
    <Stack spacing={0.25} alignItems="flex-end">
      <Typography variant="body2">
        {formatOptionalUsd(shadow.selectedPrice)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {shadow.basis === "modeled"
          ? formatDays(shadow.estimatedMedianSellDays)
          : describeDecisionBasis(shadow)}
        {" · "}
        {describeDecisionRule(shadow)}
      </Typography>
    </Stack>
  );
}

export function ProductPriceMatrixTable({
  matrix,
}: {
  matrix: ProductPriceMatrixResponse;
}) {
  const shadowMethod = matrix.cells.find(
    (cell) => cell.shadowPricingDecision !== undefined,
  )?.shadowPricingDecision?.method;

  return (
    <TableContainer component={Box} sx={{ overflowX: "auto" }}>
      <Table
        size="small"
        aria-label="Product prices by condition and variant"
        sx={{ minWidth: 1250 }}
      >
        <TableHead>
          <TableRow>
            <TableCell
              sx={{
                ...STICKY_HEADER,
                left: 0,
                width: VARIANT_COLUMN_WIDTH,
                minWidth: VARIANT_COLUMN_WIDTH,
                maxWidth: VARIANT_COLUMN_WIDTH,
              }}
            >
              Variant
            </TableCell>
            <TableCell
              sx={{
                ...STICKY_HEADER,
                left: VARIANT_COLUMN_WIDTH,
                width: CONDITION_COLUMN_WIDTH,
                minWidth: CONDITION_COLUMN_WIDTH,
                maxWidth: CONDITION_COLUMN_WIDTH,
              }}
            >
              Condition
            </TableCell>
            <TableCell
              align="right"
              sx={{
                ...STICKY_HEADER,
                left: VARIANT_COLUMN_WIDTH + CONDITION_COLUMN_WIDTH,
                borderRight: "1px solid",
                borderRightColor: "divider",
                width: MARKET_COLUMN_WIDTH,
                minWidth: MARKET_COLUMN_WIDTH,
                maxWidth: MARKET_COLUMN_WIDTH,
              }}
            >
              Market
            </TableCell>
            <TableCell align="right" sx={{ fontWeight: 700, minWidth: 90 }}>
              Low
            </TableCell>
            <TableCell align="right" sx={{ fontWeight: 700, minWidth: 90 }}>
              High
            </TableCell>
            <TableCell align="right" sx={{ fontWeight: 700, minWidth: 70 }}>
              Sales
            </TableCell>
            {matrix.listingsIncluded && (
              <TableCell align="right" sx={{ fontWeight: 700, minWidth: 110 }}>
                Your listing
              </TableCell>
            )}
            <TableCell
              align="right"
              sx={{
                fontWeight: 700,
                minWidth: 190,
                borderLeft: "1px solid",
                borderLeftColor: "divider",
              }}
            >
              Sell at
            </TableCell>
            <TableCell align="right" sx={{ fontWeight: 700, minWidth: 100 }}>
              vs market
            </TableCell>
            {shadowMethod && (
              <TableCell align="right" sx={{ fontWeight: 700, minWidth: 150 }}>
                {policyMethodLabel(shadowMethod)}
              </TableCell>
            )}
            <TableCell sx={{ fontWeight: 700, minWidth: 140 }}>Notes</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {matrix.cells.map((cell, index) => {
            const conditionColor = getConditionColor(cell.condition);
            const startsVariantGroup =
              index === 0 || matrix.cells[index - 1]?.variant !== cell.variant;
            const groupBorder = {
              borderTop: startsVariantGroup ? "2px solid" : undefined,
              borderTopColor: "divider",
            };

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
                    ...groupBorder,
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
                    ...groupBorder,
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
                    ...groupBorder,
                  }}
                >
                  {formatOptionalUsd(cell.tcgMarketPrice)}
                </TableCell>
                <TableCell align="right" sx={groupBorder}>
                  {formatOptionalUsd(cell.lowestSalePrice)}
                </TableCell>
                <TableCell align="right" sx={groupBorder}>
                  {formatOptionalUsd(cell.highestSalePrice)}
                </TableCell>
                <TableCell align="right" sx={groupBorder}>
                  {cell.saleCount.toLocaleString()}
                </TableCell>
                {matrix.listingsIncluded && (
                  <TableCell align="right" sx={groupBorder}>
                    <ListingCell cell={cell} />
                  </TableCell>
                )}
                <TableCell
                  align="right"
                  sx={(theme) => ({
                    ...groupBorder,
                    borderLeft: "1px solid",
                    borderLeftColor: getConditionAccentColor(cell.condition),
                    ...(cell.sellAtPrice !== null
                      ? getConditionTintStyles(
                          cell.condition,
                          theme,
                          theme.palette.mode === "dark" ? 0.24 : 0.1,
                        )
                      : {}),
                  })}
                >
                  <SellAtCell
                    cell={cell}
                    priced={matrix.suggestedPricesIncluded}
                  />
                </TableCell>
                <TableCell align="right" sx={groupBorder}>
                  <MarketDelta
                    price={cell.sellAtPrice}
                    market={cell.tcgMarketPrice}
                  />
                </TableCell>
                {shadowMethod && (
                  <TableCell align="right" sx={groupBorder}>
                    <ShadowCell cell={cell} />
                  </TableCell>
                )}
                <TableCell sx={groupBorder}>
                  <ConditionNotes cell={cell} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
