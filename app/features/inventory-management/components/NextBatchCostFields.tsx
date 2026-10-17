import {
  Checkbox,
  FormControl,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  DEFAULT_ESTIMATED_COST_RATE,
  describeEstimatedCostRate,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { CostRateFields } from "./CostRateFields";
import type { NextBatchCost, NextBatchCostMethod } from "../services/nextBatchCost";

/** Chooses how the next queued batch is costed: the default estimate, a rate of your own, or a purchase total. */
export function NextBatchCostFields({
  value,
  onChange,
}: {
  value: NextBatchCost;
  onChange: (value: NextBatchCost) => void;
}) {
  return (
    <Stack spacing={1} component="section" aria-labelledby="next-batch-cost-heading">
      <FormControl>
        <Typography id="next-batch-cost-heading" variant="subtitle2">
          Cost of the next batch
        </Typography>
        <RadioGroup
          value={value.method}
          aria-labelledby="next-batch-cost-heading"
          onChange={(event) => onChange({ ...value, method: event.target.value as NextBatchCostMethod })}
        >
          <FormControlLabel
            value="estimate"
            control={<Radio size="small" />}
            label={`Default estimate: ${describeEstimatedCostRate(DEFAULT_ESTIMATED_COST_RATE)}`}
          />
          <FormControlLabel value="cost_rate" control={<Radio size="small" />} label="My own rate" />
          <FormControlLabel value="purchase_total" control={<Radio size="small" />} label="Purchase total" />
        </RadioGroup>
      </FormControl>
      {value.method === "cost_rate" && (
        <Stack spacing={1}>
          <CostRateFields value={value.costRate} onChange={(costRate) => onChange({ ...value, costRate })} />
          <Typography variant="caption" color="text.secondary">
            The rate stays selected for later batches of this lot until you change it or reload the page. It also
            costs cards whose market price is found after intake, and you can change a queued batch's rate in
            Background batches.
          </Typography>
        </Stack>
      )}
      {value.method === "purchase_total" && (
        <Stack spacing={1}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Purchase reference"
              value={value.purchaseReference}
              required
              size="small"
              onChange={(event) => onChange({ ...value, purchaseReference: event.target.value })}
            />
            <TextField
              label="Purchase total (USD)"
              value={value.purchaseTotal}
              required
              size="small"
              slotProps={{ htmlInput: { inputMode: "decimal" } }}
              onChange={(event) => onChange({ ...value, purchaseTotal: event.target.value })}
            />
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center">
            <TextField
              label="Purchase date"
              type="date"
              value={value.purchaseDate}
              size="small"
              slotProps={{ inputLabel: { shrink: true } }}
              onChange={(event) => onChange({ ...value, purchaseDate: event.target.value })}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={value.purchaseEstimated}
                  onChange={(event) => onChange({ ...value, purchaseEstimated: event.target.checked })}
                />
              }
              label="Estimated"
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Enter only this handoff's share if the purchase is split across batches. It is split across the cards by
            quantity and clears after the batch is queued.
          </Typography>
        </Stack>
      )}
      <Typography variant="caption" component="p" color="text.secondary">
        Cost feeds margins and Inventory Economics; pricing does not use it. Estimates use each card's market price at
        intake, so a card worth less than the amount per card counts as negative cost.
      </Typography>
    </Stack>
  );
}
