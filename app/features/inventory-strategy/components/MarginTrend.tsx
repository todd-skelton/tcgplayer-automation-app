import {
  Box,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import { ESTIMATED_PURCHASE_COST_RULE } from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { TRAILING_MARGIN_WEEKS, type MarginTrend as MarginTrendReport, type MarginTrendWeek } from "../domain/marginTrend";
import { currencyFormatter } from "./format";

/** Share of a week's sales that must be costed for its margin to be read as complete. */
const COSTED_SALES_THRESHOLD = 0.9;

const dayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const formatDay = (isoDay: string) => dayFormatter.format(new Date(`${isoDay}T00:00:00Z`));
const percent = (value: number | null) => value === null ? "N/A" : `${value.toFixed(1)}%`;
const perDay = (value: number | null) => value === null ? "N/A" : `${value.toFixed(2)}%/day`;
const costedShare = (week: MarginTrendWeek) =>
  week.summary.grossCents > 0 ? week.summary.includedGrossCents / week.summary.grossCents : 0;
const isComplete = (week: MarginTrendWeek) => week.ended && costedShare(week) >= COSTED_SALES_THRESHOLD;

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 20, right: 16, bottom: 28, left: 44 };

function Chart({ trend }: { trend: MarginTrendReport }) {
  const theme = useTheme();
  const { weeks } = trend;
  const values = weeks.flatMap((week) => [week.summary.marginPercent, week.trailingMarginPercent])
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  const low = Math.min(0, Math.floor(Math.min(...values) / 5) * 5);
  const high = Math.max(5, Math.ceil(Math.max(...values) / 5) * 5);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const step = plotWidth / Math.max(1, weeks.length);
  // A week's point sits at its middle; a date sits at its share of the week.
  const xOfWeek = (index: number) => PAD.left + step * (index + 0.5);
  const firstWeek = Date.parse(`${weeks[0].weekStart}T00:00:00Z`);
  const xOfDay = (isoDay: string) =>
    PAD.left + step * ((Date.parse(`${isoDay}T00:00:00Z`) - firstWeek) / (7 * 24 * 60 * 60 * 1000));
  const y = (value: number) => PAD.top + plotHeight * (1 - (value - low) / (high - low));
  const path = (pick: (week: MarginTrendWeek) => number | null) => weeks
    .map((week, index) => ({ value: pick(week), x: xOfWeek(index) }))
    .filter((point): point is { value: number; x: number } => point.value !== null)
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(" ");
  const gridlines = Array.from({ length: (high - low) / 5 + 1 }, (_, index) => low + index * 5)
    .filter((value, _, all) => all.length <= 8 || value % 10 === 0);
  const weekColor = theme.palette.text.secondary;
  const trailingColor = theme.palette.primary.main;
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="Weekly realized margin with the trailing four-week margin"
      sx={{ width: "100%", height: "auto", display: "block", mt: 2 }}
    >
      {gridlines.map((value) => (
        <g key={value}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(value)} y2={y(value)}
            stroke={theme.palette.divider} strokeWidth={value === 0 ? 1.5 : 1} />
          <text x={PAD.left - 6} y={y(value) + 4} textAnchor="end" fontSize={11} fill={weekColor}>{value}%</text>
        </g>
      ))}
      {trend.pricingChanges.map((change, index) => {
        const x = xOfDay(change.changedOn);
        return x < PAD.left || x > WIDTH - PAD.right ? null : (
          <g key={change.changedOn}>
            <line x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom}
              stroke={theme.palette.warning.main} strokeDasharray="4 3" />
            <text x={x} y={PAD.top - 6} textAnchor="middle" fontSize={11} fill={theme.palette.warning.dark}>{index + 1}</text>
          </g>
        );
      })}
      <path d={path((week) => week.summary.marginPercent)} fill="none" stroke={weekColor} strokeWidth={1} opacity={0.6} />
      <path d={path((week) => week.trailingMarginPercent)} fill="none" stroke={trailingColor} strokeWidth={2.5} />
      {weeks.map((week, index) => week.summary.marginPercent === null ? null : (
        <circle key={week.weekStart} cx={xOfWeek(index)} cy={y(week.summary.marginPercent)} r={4}
          fill={isComplete(week) ? weekColor : theme.palette.background.paper} stroke={weekColor} strokeWidth={1.5}>
          <title>{`Week of ${formatDay(week.weekStart)}: ${percent(week.summary.marginPercent)}`}</title>
        </circle>
      ))}
      {weeks.map((week, index) => index % Math.ceil(weeks.length / 9) ? null : (
        <text key={week.weekStart} x={xOfWeek(index)} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill={weekColor}>
          {formatDay(week.weekStart)}
        </text>
      ))}
    </Box>
  );
}

/**
 * Realized margin week by week, smoothed over four weeks, with the price,
 * market, and fee ratios that move it and the days pricing changed.
 */
export function MarginTrend({ trend }: { trend: MarginTrendReport | null }) {
  if (!trend || trend.weeks.length === 0) return null;
  const rule = ESTIMATED_PURCHASE_COST_RULE;
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Typography variant="h6">Margin over time</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Each week's realized margin (thin line) and the margin over the trailing {TRAILING_MARGIN_WEEKS} weeks (bold line).
        Hollow points are weeks still in progress or with less than {COSTED_SALES_THRESHOLD * 100}% of sales costed.
        Estimated costs are {rule.marketRate * 100}% of the market price at intake less {currencyFormatter.format(rule.perUnitDeductionCents / 100)} a card,
        so margin follows three ratios: the sale price against the market when it sold, how the market moved since intake,
        and what fees, postage, and refunds leave of the sale.
      </Typography>
      <Chart trend={trend} />
      {trend.pricingChanges.length ? (
        <Stack component="ol" spacing={0.5} sx={{ mt: 1, mb: 0, pl: 3 }}>
          {trend.pricingChanges.map((change) => (
            <Typography component="li" variant="body2" key={change.changedOn}>
              {formatDay(change.changedOn)}: {change.changes.join("; ")}
            </Typography>
          ))}
        </Stack>
      ) : null}
      <TableContainer sx={{ mt: 2 }}>
        <Table size="small" aria-label="Realized margin by week">
          <TableHead>
            <TableRow>
              <TableCell>Week of</TableCell>
              <TableCell align="right">Sold</TableCell>
              <TableCell align="right">Sales costed</TableCell>
              <TableCell align="right">Margin</TableCell>
              <TableCell align="right">{TRAILING_MARGIN_WEEKS}-week margin</TableCell>
              <TableCell align="right">Return on capital</TableCell>
              <TableCell align="right">Price vs market</TableCell>
              <TableCell align="right">Market since intake</TableCell>
              <TableCell align="right">Net of fees</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {[...trend.weeks].reverse().map((week) => (
              <TableRow key={week.weekStart}>
                <TableCell sx={{ whiteSpace: "nowrap" }}>{formatDay(week.weekStart)}{week.ended ? "" : " (so far)"}</TableCell>
                <TableCell align="right">{week.summary.unitsSold.toLocaleString()}</TableCell>
                <TableCell align="right">
                  {week.summary.grossCents > 0 ? `${Math.round(costedShare(week) * 100)}%` : "N/A"}
                </TableCell>
                <TableCell align="right">{percent(week.summary.marginPercent)}</TableCell>
                <TableCell align="right">{percent(week.trailingMarginPercent)}</TableCell>
                <TableCell align="right">{perDay(week.summary.dailyReturnPercent)}</TableCell>
                <TableCell align="right">{percent(week.drivers.priceToMarketPercent)}</TableCell>
                <TableCell align="right">{percent(week.drivers.marketChangePercent)}</TableCell>
                <TableCell align="right">{percent(week.drivers.netToGrossPercent)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
