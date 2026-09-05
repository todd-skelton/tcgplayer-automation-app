import { Chip, Stack, Tooltip } from "@mui/material";
import { formatOptionalUsd } from "~/core/utils/marketDelta";
import type { ProductPriceMatrixCell } from "../types/productPriceMatrix";

/**
 * What stood in for the condition's own market data, plus the pricing
 * warnings and errors. Shared by the matrix table and the refund helper so
 * both read the same caveats the same way.
 */
export function ConditionNotes({
  cell,
  showErrors = true,
}: {
  cell: ProductPriceMatrixCell;
  /** The refund helper leaves errors to the table. */
  showErrors?: boolean;
}) {
  const normalization = cell.conditionNormalization;
  const anchor = normalization?.anchorCondition;
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {cell.tcgMarketPrice === null && (
        <Chip size="small" variant="outlined" label="No market" />
      )}
      {anchor && (
        <Tooltip
          title={`No market price for ${cell.condition}, so it is valued as ${anchor} until its own sales say otherwise.`}
        >
          <Chip size="small" variant="outlined" label={`Valued as ${anchor}`} />
        </Tooltip>
      )}
      {normalization?.method === "neutral-condition-fallback" && (
        <Tooltip title="No sales or market price for this or any sibling condition, so it is priced from the other conditions without a condition discount. Treat the sell-at price as an upper bound.">
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="No condition data"
          />
        </Tooltip>
      )}
      {cell.aboveBetterCondition && (
        <Tooltip
          title={`The model priced this condition above a better one; refunds use ${formatOptionalUsd(cell.ladderPrice)} instead.`}
        >
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="Above a better condition"
          />
        </Tooltip>
      )}
      {showErrors && cell.warnings.length > 0 && (
        <Tooltip title={cell.warnings.join(" ")}>
          <Chip size="small" color="warning" label="Warning" />
        </Tooltip>
      )}
      {showErrors && cell.errors.length > 0 && (
        <Tooltip title={cell.errors.join(" ")}>
          <Chip size="small" color="error" label="Error" />
        </Tooltip>
      )}
    </Stack>
  );
}
