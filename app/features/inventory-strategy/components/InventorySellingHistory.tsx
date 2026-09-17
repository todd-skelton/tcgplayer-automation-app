import {
  Box,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useSearchParams } from "react-router";
import {
  SELLING_HISTORY_WINDOWS,
  type InventorySellingHistoryReport,
  type SellingHistorySummary,
} from "../types/inventorySellingHistory";

function quantity(value: number): string {
  return value.toLocaleString();
}

function unitLabel(value: number): string {
  return `${quantity(value)} ${value === 1 ? "unit" : "units"}`;
}

function days(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(1)} days`;
}

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ my: 0.25 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {detail}
      </Typography>
    </Box>
  );
}

function Summary({ summary }: { summary: SellingHistorySummary }) {
  const knownRemaining =
    summary.remainingWithKnownAgeQuantity +
    summary.remainingWithUncertainPresenceQuantity;
  const remaining = Math.max(
    0,
    summary.cohortQuantity - summary.soldQuantity - summary.removedQuantity,
  );
  const remainingWithUnknownListedDate = Math.max(0, remaining - knownRemaining);
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" },
        gap: 2,
      }}
    >
      <Stat
        label="Sold"
        value={unitLabel(summary.soldQuantity)}
        detail={`${unitLabel(summary.soldWithKnownListedDateQuantity)} with a known listed date`}
      />
      <Stat
        label="Sold-only average"
        value={days(summary.soldOnlyAverageDays)}
        detail="Observed time listed before sale; it is not an expected wait for all inventory"
      />
      <Stat
        label="Median / P90"
        value={`${days(summary.medianDaysToSale)} / ${days(summary.p90DaysToSale)}`}
        detail={
          summary.percentileStatus === "estimable"
            ? "Time listed before sale"
            : `Unavailable: ${statusLabel(summary.percentileStatus)}`
        }
      />
      <Stat
        label="Ledger expected remaining"
        value={unitLabel(remaining)}
        detail={`${unitLabel(summary.remainingWithKnownAgeQuantity)} with known age · ${unitLabel(summary.remainingWithUncertainPresenceQuantity)} uncertain presence · ${unitLabel(remainingWithUnknownListedDate)} unknown listed date`}
      />
    </Box>
  );
}

function SellThrough({ summary }: { summary: SellingHistorySummary }) {
  return (
    <TableContainer sx={{ mt: 2, overflowX: "auto" }}>
      <Table size="small" aria-label="Age-eligible sell-through">
        <TableHead>
          <TableRow>
            <TableCell>Age-eligible sell-through</TableCell>
            <TableCell align="right">Eligible</TableCell>
            <TableCell align="right">Sold</TableCell>
            <TableCell align="right">Rate</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {summary.sellThrough.map((horizon) => (
            <TableRow key={horizon.days}>
              <TableCell>{horizon.days} days</TableCell>
              <TableCell align="right">{unitLabel(horizon.eligibleQuantity)}</TableCell>
              <TableCell align="right">{unitLabel(horizon.soldQuantity)}</TableCell>
              <TableCell align="right">
                {horizon.rate === null
                  ? horizon.status === "unsettled_outcomes"
                    ? "Unavailable: unsettled outcomes"
                    : "Unavailable"
                  : `${(horizon.rate * 100).toFixed(1)}%`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function Coverage({ report }: { report: Extract<InventorySellingHistoryReport, { status: "ready" }> }) {
  const { orderCoverage, overall } = report;
  const gaps = orderCoverage.gaps.filter(Boolean);
  const unknownListed = overall.unknownListedDateQuantity;
  return (
    <Stack spacing={0.5} sx={{ mt: 2 }}>
      <Typography variant="caption" color="text.secondary">
        Order history {statusLabel(orderCoverage.status)}
        {orderCoverage.observedThrough ? ` through ${date(orderCoverage.observedThrough)}` : ""}
        {` · ${unitLabel(overall.knownListedDateQuantity)} of ${unitLabel(overall.cohortQuantity)} with a known listed date`}
        {unknownListed > 0 ? ` · ${unitLabel(unknownListed)} with an unknown listed date are excluded from timing` : ""}
      </Typography>
      {(gaps.length > 0 || orderCoverage.error) && (
        <Typography variant="caption" color="warning.main">
          {gaps.length ? `History gaps: ${gaps.join("; ")}` : ""}
          {gaps.length && orderCoverage.error ? " · " : ""}
          {orderCoverage.error ? `Last sync issue: ${orderCoverage.error}` : ""}
        </Typography>
      )}
    </Stack>
  );
}

function ProductLines({ report }: { report: Extract<InventorySellingHistoryReport, { status: "ready" }> }) {
  if (!report.productLines.length) return null;
  return (
    <TableContainer sx={{ mt: 2, overflowX: "auto" }}>
      <Table size="small" aria-label="Product-line selling history">
        <TableHead>
          <TableRow>
            <TableCell>Product line</TableCell>
            <TableCell align="right">Cohort</TableCell>
            <TableCell align="right">Sold</TableCell>
            <TableCell align="right">Sold-only average</TableCell>
            <TableCell align="right">Remaining known age</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {report.productLines.map((line) => (
            <TableRow key={line.productLine}>
              <TableCell>{line.productLine}</TableCell>
              <TableCell align="right">{unitLabel(line.cohortQuantity)}</TableCell>
              <TableCell align="right">{unitLabel(line.soldQuantity)}</TableCell>
              <TableCell align="right">{days(line.soldOnlyAverageDays)}</TableCell>
              <TableCell align="right">{unitLabel(line.remainingWithKnownAgeQuantity)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ScopeControls({ report }: { report: InventorySellingHistoryReport }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const updateScope = (key: "historyDays" | "historyProductLine", value: string) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (key === "historyProductLine" && value === "") {
      nextSearchParams.delete(key);
    } else {
      nextSearchParams.set(key, value);
    }
    setSearchParams(nextSearchParams);
  };

  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1.5 }}>
      <FormControl size="small" sx={{ minWidth: 150 }}>
        <InputLabel id="selling-history-window-label">History window</InputLabel>
        <Select
          labelId="selling-history-window-label"
          label="History window"
          value={String(report.scope.windowDays)}
          onChange={(event) => updateScope("historyDays", event.target.value)}
        >
          {SELLING_HISTORY_WINDOWS.map((windowDays) => (
            <MenuItem key={windowDays} value={String(windowDays)}>
              Last {windowDays} days
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl size="small" sx={{ minWidth: 180 }}>
        <InputLabel id="selling-history-product-line-label">Product line</InputLabel>
        <Select
          labelId="selling-history-product-line-label"
          label="Product line"
          value={report.scope.productLine ?? ""}
          onChange={(event) =>
            updateScope("historyProductLine", event.target.value)
          }
        >
          <MenuItem value="">All product lines</MenuItem>
          {report.availableProductLines.map((productLine) => (
            <MenuItem key={productLine} value={productLine}>
              {productLine}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
}

/** Observed listing exposure and sales outcomes for the current seller. */
export function InventorySellingHistory({ report }: { report: InventorySellingHistoryReport }) {
  if (report.status === "unavailable") {
    return (
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6">Selling history</Typography>
        <ScopeControls report={report} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Selling history is unavailable: {statusLabel(report.reason)}.
        </Typography>
        <Chip size="small" variant="outlined" sx={{ mt: 1 }} label={`Order history: ${statusLabel(report.orderCoverage.status)}`} />
      </Paper>
    );
  }

  const noEvidence = report.overall.cohortQuantity === 0;
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography variant="h6">Selling history</Typography>
        <Chip size="small" color="success" variant="outlined" label="Observed listing exposure" />
      </Stack>
      <ScopeControls report={report} />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Analysis from {date(report.analysisFrom)} · As of {date(report.asOf)}. Time listed is separate from intake-to-sale age.
      </Typography>
      {noEvidence ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          No published listing cohorts are available in this analysis window yet.
        </Typography>
      ) : (
        <>
          <Box sx={{ mt: 2 }}><Summary summary={report.overall} /></Box>
          <SellThrough summary={report.overall} />
          <ProductLines report={report} />
        </>
      )}
      <Coverage report={report} />
    </Paper>
  );
}
