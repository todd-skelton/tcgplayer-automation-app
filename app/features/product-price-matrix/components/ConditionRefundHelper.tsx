import {
  Alert,
  Box,
  Divider,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { formatOptionalUsd, formatSignedUsd } from "~/core/utils/marketDelta";
import { formatDays } from "~/features/pricing/components/policyLabel";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import type { Variant } from "~/integrations/tcgplayer/types/Variant";
import { estimateRefund } from "../services/conditionLadder";
import { ConditionNotes } from "./ConditionNotes";
import type {
  ProductPriceMatrixCell,
  ProductPriceMatrixResponse,
} from "../types/productPriceMatrix";

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});

function parsePrice(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The price a buyer most likely paid: the in-stock listing, else the sell-at price, else market. */
function defaultPricePaid(cell: ProductPriceMatrixCell | undefined): string {
  const listing =
    cell?.listing && cell.listing.inStock && cell.listing.quantity > 0
      ? cell.listing.price
      : null;
  const price = listing ?? cell?.sellAtPrice ?? cell?.tcgMarketPrice ?? null;
  return price === null ? "" : price.toFixed(2);
}

function nextWorse(conditions: Condition[], condition: Condition): Condition {
  const index = conditions.indexOf(condition);
  return conditions[Math.min(conditions.length - 1, index + 1)] ?? condition;
}

/**
 * Turns a condition dispute into a number: what the buyer paid, less the
 * share of that price the received condition would still sell for. The
 * sell-at ladder decides; the market ladder shows how far that sits from
 * TCGplayer's own view.
 */
export function ConditionRefundHelper({
  matrix,
}: {
  matrix: ProductPriceMatrixResponse;
}) {
  // Selections are stored only once the user picks them; until then each
  // falls back to a default derived from the matrix. Mount with a key tied
  // to the priced matrix so a new pricing run starts from the defaults.
  const [chosenVariant, setChosenVariant] = useState<Variant | null>(null);
  const [chosenSold, setChosenSold] = useState<Condition | null>(null);
  const [chosenReceived, setChosenReceived] = useState<Condition | null>(null);
  const [enteredPrice, setEnteredPrice] = useState<string | null>(null);

  const variants = matrix.variants;
  const variant: Variant | "" =
    chosenVariant !== null && variants.includes(chosenVariant)
      ? chosenVariant
      : (variants.at(0) ?? "");
  // Cells arrive sorted by variant then condition, so this keeps that order.
  const conditions = [
    ...new Set(
      matrix.cells
        .filter((cell) => cell.variant === variant)
        .map((cell) => cell.condition),
    ),
  ];
  const soldCondition: Condition | "" =
    chosenSold !== null && conditions.includes(chosenSold)
      ? chosenSold
      : (conditions.at(0) ?? "");
  const receivedCondition: Condition | "" =
    chosenReceived !== null && conditions.includes(chosenReceived)
      ? chosenReceived
      : soldCondition === ""
        ? ""
        : nextWorse(conditions, soldCondition);

  const cellFor = (condition: Condition | ""): ProductPriceMatrixCell | undefined =>
    condition === ""
      ? undefined
      : matrix.cells.find(
          (cell) => cell.variant === variant && cell.condition === condition,
        );

  const sold = cellFor(soldCondition);
  const received = cellFor(receivedCondition);
  const pricePaid = enteredPrice ?? defaultPricePaid(sold);
  const paid = parsePrice(pricePaid);
  const refundFrom = (price: "ladderPrice" | "marketLadderPrice") =>
    estimateRefund({
      pricePaid: paid,
      soldConditionPrice: sold?.[price] ?? null,
      receivedConditionPrice: received?.[price] ?? null,
    });
  const bySellAt = refundFrom("ladderPrice");
  const byMarket = refundFrom("marketLadderPrice");
  const sameCondition =
    soldCondition !== "" && soldCondition === receivedCondition;
  const receivedModeled = received?.pricingDecision?.basis === "modeled";

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6">Condition dispute</Typography>
          <Typography variant="body2" color="text.secondary">
            The refund that leaves the buyer paying what the received condition
            would sell for, as a share of what they paid.
          </Typography>
        </Box>

        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          {variants.length > 1 && (
            <FormControl sx={{ minWidth: 180 }}>
              <InputLabel>Variant</InputLabel>
              <Select
                value={variant}
                label="Variant"
                onChange={(event) => {
                  setChosenVariant(event.target.value as Variant);
                  setEnteredPrice(null);
                }}
              >
                {variants.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <FormControl sx={{ minWidth: 200 }}>
            <InputLabel>Sold as</InputLabel>
            <Select
              value={soldCondition}
              label="Sold as"
              onChange={(event) => {
                setChosenSold(event.target.value as Condition);
                setEnteredPrice(null);
              }}
            >
              {conditions.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl sx={{ minWidth: 200 }}>
            <InputLabel>Received as</InputLabel>
            <Select
              value={receivedCondition}
              label="Received as"
              onChange={(event) =>
                setChosenReceived(event.target.value as Condition)
              }
            >
              {conditions.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Price paid"
            value={pricePaid}
            onChange={(event) => setEnteredPrice(event.target.value)}
            inputMode="decimal"
            InputProps={{
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            }}
            sx={{ minWidth: 160 }}
          />
        </Stack>

        {sameCondition ? (
          <Alert severity="info">
            Sold and received conditions match, so there is nothing to refund.
          </Alert>
        ) : bySellAt === null ? (
          <Alert severity="warning">
            {paid === null
              ? "Enter the price the buyer paid."
              : "One of these conditions has no sell-at price, so the refund cannot be sized from what you would sell at."}
          </Alert>
        ) : (
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={3}
            divider={<Divider orientation="vertical" flexItem />}
          >
            <Box sx={{ minWidth: 220 }}>
              <Typography variant="overline" color="text.secondary">
                Refund by what you would sell at
              </Typography>
              <Typography variant="h4" fontWeight={700}>
                {formatOptionalUsd(bySellAt.refund)}
              </Typography>
              {bySellAt.retainedShare >= 1 ? (
                <Typography variant="body2" color="warning.main">
                  Your pricing puts {receivedCondition} at or above{" "}
                  {soldCondition} for this card, so it sees no loss in the
                  downgrade. Lean on the market refund or take the card back.
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Buyer keeps paying {formatOptionalUsd(bySellAt.netPrice)},
                  which is {percentFormatter.format(bySellAt.retainedShare)} of{" "}
                  {formatOptionalUsd(paid)}.
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary">
                {receivedCondition} sells at{" "}
                {formatOptionalUsd(received?.ladderPrice)} against{" "}
                {formatOptionalUsd(sold?.ladderPrice)} for {soldCondition}.
              </Typography>
            </Box>
            <Box sx={{ minWidth: 220 }}>
              <Typography variant="overline" color="text.secondary">
                Refund by market
              </Typography>
              <Typography variant="h5" fontWeight={700}>
                {byMarket ? formatOptionalUsd(byMarket.refund) : "N/A"}
              </Typography>
              {byMarket ? (
                <Typography variant="body2" color="text.secondary">
                  {formatSignedUsd(byMarket.refund - bySellAt.refund)} versus
                  your sell-at refund. Market has {receivedCondition} at{" "}
                  {formatOptionalUsd(received?.marketLadderPrice)} and{" "}
                  {soldCondition} at {formatOptionalUsd(sold?.marketLadderPrice)}.
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  One of the conditions has no market price.
                </Typography>
              )}
            </Box>
            <Box sx={{ minWidth: 220 }}>
              <Typography variant="overline" color="text.secondary">
                If it comes back
              </Typography>
              <Typography variant="h5" fontWeight={700}>
                {formatOptionalUsd(received?.sellAtPrice)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Relist the {receivedCondition} copy at this price
                {receivedModeled &&
                received?.estimatedTimeToSellDays !== undefined
                  ? `, expected to sell in ${formatDays(received.estimatedTimeToSellDays)}`
                  : ""}
                .
              </Typography>
              {received && (
                <Box sx={{ mt: 1 }}>
                  <ConditionNotes cell={received} showErrors={false} />
                </Box>
              )}
            </Box>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
