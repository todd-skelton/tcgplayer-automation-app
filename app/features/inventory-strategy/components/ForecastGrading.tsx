import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { Fragment, useState } from "react";
import type { PricingPolicyConfig } from "~/features/pricing/types/config";
import {
  DEFAULT_FORECAST_GRADING_HORIZON_DAYS,
  FORECAST_GRADING_HORIZON_DAYS,
  type ForecastGradingReport,
} from "../types/inventoryStrategy";
import { percentFormatter } from "./format";
import { GRADED_FORECASTS } from "./verdict";

export function ForecastGrading({
  reports,
  policyMethod,
}: {
  reports: ForecastGradingReport[];
  policyMethod: PricingPolicyConfig["method"];
}) {
  const [gradingHorizonDays, setGradingHorizonDays] = useState(
    DEFAULT_FORECAST_GRADING_HORIZON_DAYS,
  );
  const grading =
    reports.find((report) => report.horizonDays === gradingHorizonDays) ??
    reports[0];
  if (!grading) return null;
  const gradedForecasts = GRADED_FORECASTS.map(
    ([label, key]) => [label, grading[key]] as const,
  );
  const gradedDecileCount = Math.max(
    0,
    ...gradedForecasts.map(([, grade]) => grade.deciles.length),
  );

  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">Forecast grading</Typography>
        <Typography variant="body2" color="text.secondary">
          Each forecast is graded over the SKUs that carried it, first priced
          between {grading.horizonDays} and {2 * grading.horizonDays} days ago
          and followed for {grading.horizonDays} days. Brier score against
          realized sales, lower is better; the base rate is the score of
          forecasting every SKU at its cohort&apos;s sold share.
        </Typography>
        {gradedForecasts.map(([label, grade]) => (
          <Typography
            key={label}
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5 }}
          >
            {label}:{" "}
            {grade.count > 0
              ? `${grade.count.toLocaleString()} SKUs, ${percentFormatter.format(grade.soldShare)} sold, Brier ${grade.brier.toFixed(4)} against a base rate of ${(grade.soldShare * (1 - grade.soldShare)).toFixed(4)}.`
              : `no SKU has carried this forecast for ${grading.horizonDays} days yet.`}
          </Typography>
        ))}
        {grading.curve.count === 0 && policyMethod === "target-horizon" ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            The target-horizon policy pins the curve forecast, so its grading
            waits for another policy.
          </Typography>
        ) : null}
        {grading.otherCalibrationCount > 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {grading.otherCalibrationCount.toLocaleString()} results carried a
            buyer-choice forecast from an earlier calibration, which is not
            graded.
          </Typography>
        ) : null}
        <ToggleButtonGroup
          size="small"
          exclusive
          value={gradingHorizonDays}
          onChange={(_, horizonDays: number | null) => {
            if (horizonDays !== null) setGradingHorizonDays(horizonDays);
          }}
          sx={{ mt: 2 }}
        >
          {FORECAST_GRADING_HORIZON_DAYS.map((horizonDays) => (
            <ToggleButton key={horizonDays} value={horizonDays}>
              {horizonDays} days
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>
      {gradedDecileCount > 0 ? (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell rowSpan={2}>Decile</TableCell>
                {gradedForecasts.map(([label]) => (
                  <TableCell key={label} align="center" colSpan={3}>
                    {label} forecast
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                {gradedForecasts.map(([label]) => (
                  <Fragment key={label}>
                    <TableCell align="right">Median days</TableCell>
                    <TableCell align="right">Sold</TableCell>
                    <TableCell align="right">Expected</TableCell>
                  </Fragment>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {Array.from({ length: gradedDecileCount }, (_, index) => (
                <TableRow key={index}>
                  <TableCell>{index + 1}</TableCell>
                  {gradedForecasts.map(([label, grade]) => {
                    const decile = grade.deciles[index];
                    return (
                      <Fragment key={label}>
                        <TableCell align="right">
                          {decile?.medianDays.toFixed(0) ?? ""}
                        </TableCell>
                        <TableCell align="right">
                          {decile
                            ? percentFormatter.format(decile.soldShare)
                            : ""}
                        </TableCell>
                        <TableCell align="right">
                          {decile
                            ? percentFormatter.format(decile.expectedShare)
                            : ""}
                        </TableCell>
                      </Fragment>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
    </Paper>
  );
}
