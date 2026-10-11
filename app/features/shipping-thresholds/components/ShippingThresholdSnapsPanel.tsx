import React from "react";
import {
  Alert,
  Box,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useFetcher } from "react-router";
import { SHIPPING_THRESHOLDS } from "~/core/types/shippingThresholds";
import {
  SHIPPING_EVIDENCE_WINDOW_DAYS,
  isValidSnapRange,
  type ShippingThresholdSnapSettings,
} from "~/features/pricing/types/config";
import { ValidatedNumberField } from "~/shared/components/ValidatedNumberField";
import type { SaleGroupSummary } from "../domain/snapOutcomes";
import type { ShippingThresholdReport } from "../services/shippingThresholds.server";

interface ShippingThresholdSnapsPanelProps {
  settings: ShippingThresholdSnapSettings;
  onChange: (settings: ShippingThresholdSnapSettings) => void;
}

const money = (value: number | undefined) =>
  value === undefined ? "N/A" : `$${value.toFixed(2)}`;
const share = (value: number | undefined) =>
  value === undefined ? "N/A" : `${Math.round(value * 100)}%`;
const count = (value: number | undefined) =>
  value === undefined ? "N/A" : value.toLocaleString();

const SALE_GROUPS: Array<{ key: "snapped" | "kept" | "justAbove"; label: string }> = [
  { key: "snapped", label: "Snapped" },
  { key: "kept", label: "Kept above" },
  { key: "justAbove", label: "All sales just above" },
];

function SaleGroupRow({ label, group }: { label: string; group: SaleGroupSummary }) {
  return (
    <TableRow>
      <TableCell>{label}</TableCell>
      <TableCell align="right">{count(group.units)}</TableCell>
      <TableCell align="right">{count(group.orders)}</TableCell>
      <TableCell align="right">{group.medianDaysToSell === undefined ? "N/A" : group.medianDaysToSell}</TableCell>
      <TableCell align="right">{count(group.unitsPerOrder)}</TableCell>
      <TableCell align="right">{share(group.ordersWithAddOns)}</TableCell>
      <TableCell align="right">{share(group.ordersReachingThreshold)}</TableCell>
      <TableCell align="right">{count(group.largestOrderUnits)}</TableCell>
      <TableCell align="right">{share(group.bulkOrderUnitShare)}</TableCell>
      <TableCell align="right">{money(group.shippingCostPerOrder)}</TableCell>
    </TableRow>
  );
}

/** Settings for listing just under shipping thresholds, the costs learned from sales, and what snapping has done. */
export function ShippingThresholdSnapsPanel({ settings, onChange }: ShippingThresholdSnapsPanelProps) {
  const report = useFetcher<ShippingThresholdReport | { error: string }>();
  const [outcomeWindowDays, setOutcomeWindowDays] = React.useState<number>(settings.evidenceWindowDays);
  const settingsKey = JSON.stringify(settings);

  React.useEffect(() => {
    report.load(`/api/shipping-thresholds?days=${outcomeWindowDays}`);
    // Reload when the saved settings or the outcome window change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeWindowDays, settingsKey]);

  const data = report.data && !("error" in report.data) ? report.data : undefined;
  const error = report.data && "error" in report.data ? report.data.error : undefined;
  const update = (changes: Partial<ShippingThresholdSnapSettings>) => onChange({ ...settings, ...changes });

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Typography variant="h6" gutterBottom>
        Shipping Threshold Snaps
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Under the profit-per-day policy, a price just above $5, $50, or $250 is
        compared with one cent under. Each price is valued after the shipping it
        is expected to cost, learned from recent orders and the baskets buyers
        place, and discounted over its forecast sell time. The lower price is
        listed only when it returns more and stays at or above the price floor.
      </Typography>
      <Stack spacing={2}>
        <FormControlLabel
          control={<Switch checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })} />}
          label="Snap prices just under shipping thresholds"
        />
        <Box sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
          {SHIPPING_THRESHOLDS.map((threshold) => (
            <FormControlLabel
              key={threshold}
              control={
                <Checkbox
                  checked={settings.thresholds.includes(threshold)}
                  onChange={(event) =>
                    update({
                      thresholds: SHIPPING_THRESHOLDS.filter((candidate) =>
                        candidate === threshold ? event.target.checked : settings.thresholds.includes(candidate),
                      ),
                    })
                  }
                />
              }
              label={`$${threshold} (list at $${(threshold - 0.01).toFixed(2)})`}
            />
          ))}
        </Box>
        <Box sx={{ display: "flex", gap: 2 }}>
          <ValidatedNumberField
            label="Snap range"
            value={settings.snapRange}
            step={0.01}
            helperText="Prices up to this fraction above a threshold are considered; 0.1 considers $50.00 to $55.00"
            isValid={isValidSnapRange}
            onCommit={(snapRange) => update({ snapRange })}
          />
          <TextField
            select
            label="Learn shipping costs from"
            value={settings.evidenceWindowDays}
            onChange={(event) => update({ evidenceWindowDays: Number(event.target.value) })}
            helperText="Trailing orders the shipping cost model is rebuilt from, at most hourly"
            sx={{ minWidth: 220 }}
          >
            {SHIPPING_EVIDENCE_WINDOW_DAYS.map((days) => (
              <MenuItem key={days} value={days}>Last {days} days</MenuItem>
            ))}
          </TextField>
        </Box>

        {error && <Alert severity="error">{error}</Alert>}
        {data && (
          <>
            <Typography variant="subtitle2">
              Learned from {count(data.costModel.orderCount)} orders and {count(data.costModel.basketCount)} units
              sold in the last {data.costModel.evidenceWindowDays} days
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Order value</TableCell>
                    <TableCell align="right">Orders</TableCell>
                    <TableCell align="right">Buyer shipping</TableCell>
                    <TableCell align="right">Postage</TableCell>
                    <TableCell>Basis</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.costModel.tiers.map((tier) => (
                    <TableRow key={tier.fromOrderValue}>
                      <TableCell>From {money(tier.fromOrderValue)}</TableCell>
                      <TableCell align="right">{count(tier.orderCount)}</TableCell>
                      <TableCell align="right">{money(tier.buyerShipping)}</TableCell>
                      <TableCell align="right">{money(tier.postage)}</TableCell>
                      <TableCell>{tier.basis === "observed" ? "Observed" : "Default (too few orders)"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Threshold</TableCell>
                    <TableCell align="right">Units sold nearby</TableCell>
                    <TableCell align="right">Shipping cost per unit one cent under</TableCell>
                    <TableCell align="right">Shipping cost per unit at threshold</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.thresholdCosts.map((cost) => (
                    <TableRow key={cost.threshold}>
                      <TableCell>{money(cost.threshold)}</TableCell>
                      <TableCell align="right">{count(cost.basketCount)}</TableCell>
                      <TableCell align="right">{cost.snapPriceShippingCost === undefined ? "Too few sales to snap" : money(cost.snapPriceShippingCost)}</TableCell>
                      <TableCell align="right">{money(cost.thresholdShippingCost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
          <Typography variant="subtitle2">What snapping has done</Typography>
          <TextField
            select
            size="small"
            value={outcomeWindowDays}
            onChange={(event) => setOutcomeWindowDays(Number(event.target.value))}
          >
            {SHIPPING_EVIDENCE_WINDOW_DAYS.map((days) => (
              <MenuItem key={days} value={days}>Last {days} days</MenuItem>
            ))}
          </TextField>
        </Box>
        <Typography variant="body2" color="text.secondary">
          Bulk is three or more of the group's units in one order, the sign of a
          buyer sweeping snapped prices. Add-ons are orders with anything else.
          Reaching the threshold is how often other items carried a snapped
          order over it anyway. Shipping cost is postage less buyer shipping
          after fees, per order.
        </Typography>
        {data?.outcomes.map((outcome) => (
          <Box key={outcome.threshold}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {money(outcome.threshold)}: {outcome.listings.snapped} SKUs snapped to {money(outcome.snapPrice)},{" "}
              {outcome.listings.kept} kept above, {outcome.listings.floor} held by the price floor
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Sales</TableCell>
                    <TableCell align="right">Units</TableCell>
                    <TableCell align="right">Orders</TableCell>
                    <TableCell align="right">Median days to sell</TableCell>
                    <TableCell align="right">Units per order</TableCell>
                    <TableCell align="right">With add-ons</TableCell>
                    <TableCell align="right">Reached threshold</TableCell>
                    <TableCell align="right">Most in one order</TableCell>
                    <TableCell align="right">Bought in bulk</TableCell>
                    <TableCell align="right">Shipping cost per order</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {SALE_GROUPS.map(({ key, label }) => (
                    <SaleGroupRow key={key} label={label} group={outcome[key]} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
