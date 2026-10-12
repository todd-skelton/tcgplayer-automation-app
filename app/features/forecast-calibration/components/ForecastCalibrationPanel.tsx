import React from "react";
import {
  Alert,
  Box,
  MenuItem,
  Paper,
  Stack,
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
  DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS,
  FORECAST_CALIBRATION_WINDOW_DAYS,
  actualDaysHurdle,
  sellTimeMultiplier,
  type ForecastCalibrationReport,
  type HeldOutCheck,
  type TimeInStock,
} from "../domain/forecastCalibrationModel";

interface ForecastCalibrationPanelProps {
  /** The profit-per-day hurdle, when that policy is active. */
  dailyReturnHurdle?: number;
}

const CHECK_LABELS: Record<HeldOutCheck, string> = {
  confirmed: "confirmed on the held-out sales",
  not_confirmed: "not confirmed: it did not forecast the held-out sales better",
  too_few_sales: "not confirmed: too few sales to check",
};

const multiplier = (value: number) => `${value.toFixed(2)}x`;
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const date = (value: string) => new Date(value).toLocaleDateString();

function TimeRow({ label, time }: { label: string; time: TimeInStock }) {
  return (
    <TableRow>
      <TableCell>{label}</TableCell>
      <TableCell align="right">{time.listings.toLocaleString()}</TableCell>
      <TableCell align="right">{time.inStockDays.toFixed(0)}</TableCell>
      <TableCell align="right">{time.sales.toLocaleString()}</TableCell>
      <TableCell align="right">{time.forecastSales.toFixed(1)}</TableCell>
      <TableCell align="right">{multiplier(sellTimeMultiplier(time))}</TableCell>
    </TableRow>
  );
}

/** How the store's listings sold against their sell-time forecasts; a report only, pricing does not apply it. */
export function ForecastCalibrationPanel({ dailyReturnHurdle }: ForecastCalibrationPanelProps) {
  const [days, setDays] = React.useState<number>(DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS);
  const status = useFetcher<ForecastCalibrationReport | { error: string }>();

  React.useEffect(() => {
    status.load(`/api/forecast-calibration?days=${days}`);
    // Reload when the window changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const report = status.data && !("error" in status.data) ? status.data : undefined;
  const error = status.data && "error" in status.data ? status.data.error : undefined;
  const whole = report && {
    listings: report.earlier.listings + report.heldOut.listings,
    inStockDays: report.earlier.inStockDays + report.heldOut.inStockDays,
    sales: report.earlier.sales + report.heldOut.sales,
    forecastSales: report.earlier.forecastSales + report.heldOut.forecastSales,
  };

  return (
    <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
      <Typography variant="h6" gutterBottom>
        Sell-Time Forecast Calibration
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        How the store&apos;s own listings sold against the days to sell the
        pricing curve forecast for them. Every published price is followed
        while it was in stock, until it was replaced or sold out, and each
        order counts as one sale. The multiplier is days actually taken per
        forecast day; it is checked by learning it from the earlier three
        quarters of the window and testing it on the latest quarter. Pricing
        uses the forecasts as they are; this report shows how far off they
        run so the daily return hurdle can account for it.
      </Typography>
      <Stack spacing={2}>
        <Box>
          <TextField
            select
            label="Measure over"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            helperText="Trailing listings and orders"
            sx={{ minWidth: 220 }}
          >
            {FORECAST_CALIBRATION_WINDOW_DAYS.map((windowDays) => (
              <MenuItem key={windowDays} value={windowDays}>Last {windowDays} days</MenuItem>
            ))}
          </TextField>
        </Box>

        {error && <Alert severity="error">{error}</Alert>}
        {report && whole && (
          <>
            <Alert severity={report.heldOutCheck === "confirmed" ? "info" : "warning"}>
              Listings took {multiplier(report.sellTimeMultiplier)} the forecast days to sell;
              the multiplier is {CHECK_LABELS[report.heldOutCheck]}.
              {dailyReturnHurdle !== undefined && (
                <>
                  {" "}The {percent(dailyReturnHurdle)} daily return hurdle applies over forecast
                  days, so it asks {percent(actualDaysHurdle(dailyReturnHurdle, report.sellTimeMultiplier))} per
                  day listings actually take. To ask a given return per actual day, set the hurdle
                  to that return times {report.sellTimeMultiplier.toFixed(2)}.
                </>
              )}
            </Alert>
            <Typography variant="subtitle2">
              Measured from {date(report.from)} through {date(report.through)}, holding out prices
              listed from {date(report.heldOutFrom)}
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Listed</TableCell>
                    <TableCell align="right">Prices</TableCell>
                    <TableCell align="right">Days in stock</TableCell>
                    <TableCell align="right">Sales seen</TableCell>
                    <TableCell align="right">Sales forecast</TableCell>
                    <TableCell align="right">Multiplier</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TimeRow label="Earlier" time={report.earlier} />
                  <TimeRow label="Held out" time={report.heldOut} />
                  <TimeRow label="Whole window" time={whole} />
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </Stack>
    </Paper>
  );
}
