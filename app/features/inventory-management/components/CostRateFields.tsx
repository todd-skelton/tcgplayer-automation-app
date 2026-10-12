import { InputAdornment, Stack, TextField, Typography } from "@mui/material";
import {
  estimateUnitCostCents,
  parseEstimatedCostRate,
  type EstimatedCostRate,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { formatCents } from "~/features/inventory-economics/domain/money";

/** A cost rate as typed: percent of market and dollars less per card. */
export interface CostRateInput {
  marketPercent: string;
  perCardDeduction: string;
}

const errorOf = (input: CostRateInput): string | undefined => {
  try {
    parseEstimatedCostRate(input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** The parsed rate, or each field's own error. */
export function readCostRateInput(input: CostRateInput):
  | { valid: true; rate: EstimatedCostRate }
  | { valid: false; marketPercentError?: string; perCardDeductionError?: string } {
  const marketPercentError = errorOf({ ...input, perCardDeduction: "0" });
  const perCardDeductionError = errorOf({ ...input, marketPercent: "0" });
  return marketPercentError || perCardDeductionError
    ? { valid: false, marketPercentError, perCardDeductionError }
    : { valid: true, rate: parseEstimatedCostRate(input) };
}

/** Percent of market and amount less per card, with what the rate makes a $1 and a $10 card cost. */
export function CostRateFields({
  value,
  onChange,
  autoFocus,
}: {
  value: CostRateInput;
  onChange: (value: CostRateInput) => void;
  autoFocus?: boolean;
}) {
  const read = readCostRateInput(value);
  return (
    <Stack spacing={1}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="Percent of market" value={value.marketPercent} required size="small"
          autoFocus={autoFocus} sx={{ width: { sm: 180 } }}
          error={!read.valid && Boolean(read.marketPercentError)}
          helperText={!read.valid && read.marketPercentError}
          slotProps={{ htmlInput: { inputMode: "decimal" },
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> } }}
          onChange={(event) => onChange({ ...value, marketPercent: event.target.value })} />
        <TextField label="Less per card" value={value.perCardDeduction} required size="small"
          sx={{ width: { sm: 180 } }}
          error={!read.valid && Boolean(read.perCardDeductionError)}
          helperText={!read.valid && read.perCardDeductionError}
          slotProps={{ htmlInput: { inputMode: "decimal" },
            input: { startAdornment: <InputAdornment position="start">$</InputAdornment> } }}
          onChange={(event) => onChange({ ...value, perCardDeduction: event.target.value })} />
      </Stack>
      {read.valid && (
        <Typography variant="body2" color="text.secondary">
          At this rate a $1.00 card costs {formatCents(estimateUnitCostCents(1, read.rate))} and a $10.00 card
          costs {formatCents(estimateUnitCostCents(10, read.rate))}.
        </Typography>
      )}
    </Stack>
  );
}
