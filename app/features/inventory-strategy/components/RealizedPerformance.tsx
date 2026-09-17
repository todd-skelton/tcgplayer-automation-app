import {
  Alert,
  Box,
  Chip,
  Paper,
  Stack,
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
import type { PerformanceSummary, PerformanceWindow, RealizedPerformance as RealizedPerformanceReport } from "../domain/realizedPerformance";
import { currencyFormatter, formatHurdle } from "./format";

const money = (cents: number) => currencyFormatter.format(cents / 100);
const percent = (value: number | null) => value === null ? "Unavailable" : `${value.toFixed(1)}%`;
const perDay = (value: number | null) => value === null ? "Unavailable" : `${value.toFixed(2)}%/day`;
const days = (value: number | null) => value === null ? "Unavailable" : `${value.toFixed(1)} days`;

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="h5" sx={{ my: 0.5 }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">{detail}</Typography>
    </Box>
  );
}

function ProductLines({ lines }: { lines: readonly PerformanceSummary[] }) {
  if (lines.length === 0) return null;
  return (
    <TableContainer sx={{ mt: 2 }}>
      <Table size="small" aria-label="Realized performance by product line">
        <TableHead>
          <TableRow>
            <TableCell>Product line</TableCell>
            <TableCell align="right">Sold</TableCell>
            <TableCell align="right">Net proceeds</TableCell>
            <TableCell align="right">Cost</TableCell>
            <TableCell align="right">Profit</TableCell>
            <TableCell align="right">Margin</TableCell>
            <TableCell align="right">Return on capital</TableCell>
            <TableCell align="right">Days held</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.productLine}>
              <TableCell>{line.productLine}</TableCell>
              <TableCell align="right">{line.unitsSold.toLocaleString()}</TableCell>
              <TableCell align="right">{money(line.proceedsCents)}</TableCell>
              <TableCell align="right">{money(line.costCents)}</TableCell>
              <TableCell align="right">{money(line.profitCents)}</TableCell>
              <TableCell align="right">{percent(line.marginPercent)}</TableCell>
              <TableCell align="right">{perDay(line.dailyReturnPercent)}</TableCell>
              <TableCell align="right">{days(line.averageDaysHeld)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * What the current strategy has actually earned: margin, profit per day,
 * and return on capital from sold units, against the configured hurdle.
 */
export function RealizedPerformance({
  report,
  error,
  windowDays,
  onWindowChange,
  configuredHurdle,
}: {
  report: RealizedPerformanceReport | null;
  error?: string | null;
  windowDays: number;
  onWindowChange: (windowDays: number) => void;
  configuredHurdle: number;
}) {
  const window: PerformanceWindow | undefined = report?.windows.find((candidate) => candidate.windowDays === windowDays)
    ?? report?.windows[0];
  const overall = window?.overall;
  const hurdlePercent = configuredHurdle * 100;
  const excludedUnits = overall ? overall.unitsSold - overall.includedUnits : 0;
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="h6">Realized performance</Typography>
        {overall?.dailyReturnPercent !== null && overall?.dailyReturnPercent !== undefined ? (
          <Chip
            size="small"
            variant="outlined"
            color={overall.dailyReturnPercent >= hurdlePercent ? "success" : "warning"}
            label={`${perDay(overall.dailyReturnPercent)} on capital · hurdle ${formatHurdle(configuredHurdle)}`}
          />
        ) : null}
        <Box sx={{ flexGrow: 1 }} />
        {report ? (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={window?.windowDays ?? windowDays}
            onChange={(_, value: number | null) => { if (value) onWindowChange(value); }}
            aria-label="Performance window"
          >
            {report.windows.map((candidate) => (
              <ToggleButton key={candidate.windowDays} value={candidate.windowDays}>
                {candidate.windowDays} days
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : null}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Sold units at their share of the order's net proceeds after fees,
        postage, and refunds, less the lot's cost. Costs are the estimated
        purchase rule unless recorded.
      </Typography>
      {error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}
      {!overall || overall.unitsSold === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          No sold units with proceeds and cost in this window yet.
        </Typography>
      ) : (
        <>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" },
              gap: 2,
              mt: 2,
            }}
          >
            <Stat
              label="Profit per day"
              value={overall.profitPerDayCents === null ? "Unavailable" : `${money(overall.profitPerDayCents)}/day`}
              detail={`${money(overall.profitCents)} profit over ${window!.coveredDays.toFixed(0)} days`}
            />
            <Stat
              label="Margin"
              value={percent(overall.marginPercent)}
              detail={`Profit over net proceeds · ${percent(overall.markupPercent)} over cost`}
            />
            <Stat
              label="Return on capital"
              value={perDay(overall.dailyReturnPercent)}
              detail={`Profit over cost-days · held ${days(overall.averageDaysHeld)} on average`}
            />
            <Stat
              label="Sold"
              value={`${overall.unitsSold.toLocaleString()} units`}
              detail={`${money(overall.proceedsCents)} net proceeds · ${money(overall.costCents)} cost${excludedUnits > 0 ? ` · ${excludedUnits.toLocaleString()} units without cost or proceeds excluded` : ""}`}
            />
          </Box>
          <ProductLines lines={window!.productLines} />
        </>
      )}
      {report ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
          As of {new Date(report.asOf).toLocaleDateString()}
          {report.firstSaleAt ? ` · sales on record since ${new Date(report.firstSaleAt).toLocaleDateString()}` : ""}
          . Opening-balance lots count as held since the inventory was first observed.
        </Typography>
      ) : null}
    </Paper>
  );
}
