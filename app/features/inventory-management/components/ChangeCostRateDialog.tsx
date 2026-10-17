import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import {
  DEFAULT_ESTIMATED_COST_RATE,
  marketPercentOf,
  type EstimatedCostRate,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { CostRateFields } from "./CostRateFields";
import { readCostRateInput } from "../services/costRateInput";

const inputOf = (rate: EstimatedCostRate) => ({
  marketPercent: marketPercentOf(rate),
  perCardDeduction: (rate.perUnitDeductionCents / 100).toFixed(2),
});

/** Changes the rate a queued batch's cost is estimated at; the earlier estimate stays in its cost history. */
export function ChangeCostRateDialog({
  batchNumber,
  currentRate,
  onClose,
  onChanged,
}: {
  batchNumber: number;
  currentRate: EstimatedCostRate | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(() => inputOf(currentRate ?? DEFAULT_ESTIMATED_COST_RATE));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = readCostRateInput(value).valid;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/inventory-economics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "change_estimated_cost_rate", batchNumber,
          marketPercent: value.marketPercent.trim(), perCardDeduction: value.perCardDeduction.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "The cost rate could not be changed.");
      onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Change cost rate for batch {batchNumber}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          The batch is re-estimated at the new rate. The earlier estimate stays in the batch's cost history, and pricing is not affected.
        </DialogContentText>
        <CostRateFields value={value} onChange={setValue} autoFocus />
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving || !valid}>
          {saving ? "Saving..." : "Save rate"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
