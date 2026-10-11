import React from "react";
import {
  Alert,
  Box,
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
import {
  FORECAST_EVIDENCE_WINDOW_DAYS,
  type ForecastCorrectionSettings,
} from "~/features/pricing/types/config";
import type { ForecastFit, ForecastFitStatus, TimeInStock } from "../domain/forecastCorrectionModel";
import type { ForecastCorrectionStatus } from "../services/forecastCorrection.server";

interface ForecastCorrectionPanelProps {
  settings: ForecastCorrectionSettings;
  onChange: (settings: ForecastCorrectionSettings) => void;
}

const STATUS_LABELS: Record<ForecastFitStatus, string> = {
  applied: "Applied",
  too_few_sales: "Too few sales",
  not_better_held_out: "Did not forecast held-out sales better",
};

const sales = (time: TimeInStock) => `${time.sales.toLocaleString()} of ${time.forecastSales.toFixed(1)}`;
const multiplier = (value: number | undefined) => (value === undefined ? "None" : `${value.toFixed(2)}x`);
const date = (value: string) => new Date(value).toLocaleDateString();

function FitRow({ fit }: { fit: ForecastFit }) {
  return (
    <TableRow>
      <TableCell>{fit.productLine}</TableCell>
      <TableCell align="right">{sales(fit.fit)}</TableCell>
      <TableCell align="right">{multiplier(fit.fitMultiplier)}</TableCell>
      <TableCell align="right">{sales(fit.heldOut)}</TableCell>
      <TableCell align="right">{multiplier(fit.baselineMultiplier)}</TableCell>
      <TableCell>{STATUS_LABELS[fit.status]}</TableCell>
      <TableCell align="right">{multiplier(fit.medianDaysMultiplier)}</TableCell>
    </TableRow>
  );
}

/** Settings for correcting sell-time forecasts by how the store's listings actually sold, and what was learned. */
export function ForecastCorrectionPanel({ settings, onChange }: ForecastCorrectionPanelProps) {
  const status = useFetcher<ForecastCorrectionStatus | { error: string }>();
  const settingsKey = JSON.stringify(settings);

  React.useEffect(() => {
    status.load(`/api/forecast-correction?days=${settings.evidenceWindowDays}`);
    // Reload when the saved settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  const data = status.data && !("error" in status.data) ? status.data : undefined;
  const error = status.data && "error" in status.data ? status.data.error : undefined;
  const report = data?.report;
  const update = (changes: Partial<ForecastCorrectionSettings>) => onChange({ ...settings, ...changes });

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Typography variant="h6" gutterBottom>
        Sell-Time Forecast Correction
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Under the target-horizon and profit-per-day policies, each price&apos;s
        forecast days to sell can be stretched or shortened by how the
        store&apos;s own listings have sold. Every published price is followed
        while it was in stock, until it was replaced or sold out, and its sales
        are compared with the sales its forecast expected. A multiplier learned
        from the earlier three quarters of the window is applied only when it
        forecasts the latest quarter better than no correction; a product line
        gets its own only when it beats the overall one on that line. The
        correction is relearned at most hourly and is never more than 3x or
        less than 0.5x.
      </Typography>
      <Stack spacing={2}>
        <FormControlLabel
          control={<Switch checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })} />}
          label="Correct sell-time forecasts by recent sales"
        />
        <Box>
          <TextField
            select
            label="Learn from"
            value={settings.evidenceWindowDays}
            onChange={(event) => update({ evidenceWindowDays: Number(event.target.value) })}
            helperText="Trailing listings and orders the correction is learned from"
            sx={{ minWidth: 220 }}
          >
            {FORECAST_EVIDENCE_WINDOW_DAYS.map((days) => (
              <MenuItem key={days} value={days}>Last {days} days</MenuItem>
            ))}
          </TextField>
        </Box>

        {error && <Alert severity="error">{error}</Alert>}
        {report && (
          <>
            <Alert severity={data.appliedToPricing ? "success" : "info"}>
              {data.appliedToPricing
                ? `Pricing applies this correction: ${multiplier(report.correction?.medianDaysMultiplier)} overall.`
                : report.correction
                  ? "Pricing does not apply this correction until it is turned on for a policy that forecasts sell time."
                  : "Nothing passed its held-out check, so pricing uses the forecasts as they are."}
            </Alert>
            <Typography variant="subtitle2">
              Learned from {(report.overall.fit.listings + report.overall.heldOut.listings).toLocaleString()} listed
              prices from {date(report.from)} through {date(report.through)}, holding out those listed
              from {date(report.heldOutFrom)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Sales are orders seen against sales forecast. A multiplier above 1x means listings
              took longer to sell than forecast.
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Product line</TableCell>
                    <TableCell align="right">Earlier sales</TableCell>
                    <TableCell align="right">Learned</TableCell>
                    <TableCell align="right">Held-out sales</TableCell>
                    <TableCell align="right">Compared with</TableCell>
                    <TableCell>Held-out check</TableCell>
                    <TableCell align="right">Applied multiplier</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <FitRow fit={report.overall} />
                  {report.productLines.map((fit) => (
                    <FitRow key={fit.productLineId} fit={fit} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </Stack>
    </Paper>
  );
}
