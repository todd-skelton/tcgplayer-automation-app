import {
  Box,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Pagination,
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
  type HistoricalPublicationEstimate,
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

function range(value: string | undefined): string | null {
  return value ? value.replaceAll("_", " ") : null;
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function historicalReasonLabel(value: string): string {
  const labels: Record<string, string> = {
    opening_coverage_missing: "Opening inventory evidence is unavailable",
    order_coverage_incomplete: "Order coverage is incomplete",
    source_bounds_exceeded: "Historical evidence exceeds safe limits",
    publication_evidence_invalid: "Publication evidence is incomplete",
    source_read_failed: "Historical evidence could not be read",
    order_history_changed: "Order quantity, SKU, or time changed",
    order_lifecycle_unsettled: "Order status is uncertain",
    order_time_unknown: "Order time is unavailable",
    event_time_tie: "Order and publication order is uncertain",
    quantity_conflict: "Recorded quantities do not reconcile",
    temporal_underflow: "A sale precedes enough recorded stock",
  };
  return labels[value] ?? statusLabel(value);
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
  const { coverage, orderCoverage, overall } = report;
  const gaps = orderCoverage.gaps.filter(Boolean);
  const rangeLabel = range(orderCoverage.searchRange);
  return (
    <Stack spacing={0.75} sx={{ mt: 2 }}>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        <Chip size="small" variant="outlined" label={`Order history: ${statusLabel(orderCoverage.status)}`} />
        <Chip size="small" variant="outlined" label={`Known listed dates ${unitLabel(overall.knownListedDateQuantity)} of ${unitLabel(overall.cohortQuantity)}`} />
        {overall.unknownListedDateQuantity > 0 && <Chip size="small" color="warning" variant="outlined" label={`${unitLabel(overall.unknownListedDateQuantity)} unknown listed date`} />}
        {coverage.openingUnknownQuantity > 0 && <Chip size="small" color="warning" variant="outlined" label={`${unitLabel(coverage.openingUnknownQuantity)} original opening quantity with unknown listed date`} />}
        {coverage.pendingProjectionQuantity > 0 && <Chip size="small" color="info" variant="outlined" label={`${unitLabel(coverage.pendingProjectionQuantity)} pending`} />}
        {coverage.heldProjectionQuantity > 0 && <Chip size="small" color="warning" variant="outlined" label={`${unitLabel(coverage.heldProjectionQuantity)} held`} />}
        {coverage.unresolvedRemovalQuantity > 0 && <Chip size="small" color="warning" variant="outlined" label={`${unitLabel(coverage.unresolvedRemovalQuantity)} unresolved removal`} />}
        {coverage.legacyUnlinkedQuantity > 0 && <Chip size="small" variant="outlined" label={`${unitLabel(coverage.legacyUnlinkedQuantity)} legacy unlinked${coverage.legacyUnlinkedForecastQuantity > 0 ? ` · ${unitLabel(coverage.legacyUnlinkedForecastQuantity)} with preserved forecast evidence` : ""}`} />}
        {coverage.olderPublicationQuantity > 0 && <Chip size="small" variant="outlined" label={`${unitLabel(coverage.olderPublicationQuantity)} older publication excluded by window`} />}
        {coverage.awaitingCutoffQuantity > 0 && <Chip size="small" variant="outlined" label={`${unitLabel(coverage.awaitingCutoffQuantity)} awaiting cutoff`} />}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {rangeLabel ? `Order search: ${rangeLabel}. ` : ""}
        Observed {orderCoverage.observedThrough ? `through ${date(orderCoverage.observedThrough)}` : "through an unknown date"}
        {orderCoverage.lastAttemptAt ? ` · Last sync attempt ${date(orderCoverage.lastAttemptAt)}` : ""}
        {orderCoverage.completedAt ? ` · Completed ${date(orderCoverage.completedAt)}` : ""}
        {orderCoverage.expectedTotal !== undefined ? ` · ${quantity(orderCoverage.ordersObserved)} of ${quantity(orderCoverage.expectedTotal)} orders observed` : ` · ${quantity(orderCoverage.ordersObserved)} orders observed`}
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

function HistoricalPublicationHistory({ estimate }: { estimate: HistoricalPublicationEstimate }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography variant="h6">Historical publication estimate</Typography>
        <Chip size="small" color="warning" variant="outlined" label="Estimated FIFO attribution" />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Confirmed quantity-addition uploads are reconciled to seller orders and the fixed opening balance
        {estimate.cutoffAt ? ` at ${date(estimate.cutoffAt)}` : ""}. Confirmation time records when the app received
        Seller Portal success; the provider live instant is bounded by the publishing request and that confirmation.
        Sale and remaining-quantity assignments assume no unrecorded inventory movement and do not change physical FIFO or current metrics.
      </Typography>
      {estimate.status === "no_data" ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          No historical quantity-addition publications are available before the opening cutoff.
        </Typography>
      ) : (
        <>
          <Box sx={{ mt: 1.5, display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 2 }}>
            <Stat label="Uploaded units" value={unitLabel(estimate.summary.publicationQuantity)} detail={`${quantity(estimate.summary.confirmedAdditionCount)} of ${quantity(estimate.summary.publicationItemCount)} uploads with confirmation time`} />
            <Stat label="Estimated attribution" value={unitLabel(estimate.summary.estimatedAdditionQuantity)} detail={`${unitLabel(estimate.summary.estimatedSoldQuantity)} sold · ${unitLabel(estimate.summary.estimatedRemainingAtCutoff)} remaining at cutoff`} />
            <Stat label="Estimated older stock" value={unitLabel(estimate.summary.reconstructedOlderQuantity)} detail={`${unitLabel(estimate.summary.reconstructedOlderRemainingAtCutoff)} remaining at cutoff`} />
            <Stat label="Needs review" value={unitLabel(estimate.summary.unsupportedAdditionQuantity)} detail={`${quantity(estimate.summary.conflictedSkuCount)} affected SKUs`} />
          </Box>
          {estimate.status === "unavailable" && (
            <Typography variant="body2" color="warning.main" sx={{ mt: 1.5 }}>
              Historical attribution is unavailable: {historicalReasonLabel(estimate.reason ?? "source_bounds_exceeded")}. The confirmed uploads remain shown as recorded facts.
            </Typography>
          )}
          {estimate.cohorts.length > 0 && (
            <Box component="details" sx={{ mt: 1.5 }}>
              <Box component="summary" sx={{ cursor: "pointer", typography: "body2", color: "text.secondary" }}>
                Inspect historical publication items ({estimate.cohorts.length === estimate.cohortCount
                  ? `all ${quantity(estimate.cohortCount)}`
                  : `showing ${quantity(estimate.cohorts.length)} of ${quantity(estimate.cohortCount)}`})
              </Box>
              <TableContainer sx={{ mt: 1, overflowX: "auto" }}>
                <Table size="small" aria-label="Historical publication estimate details">
                  <TableHead><TableRow>
                    <TableCell>Publication</TableCell><TableCell>Recorded confirmation</TableCell>
                    <TableCell align="right">Quantity / estimated sold / estimated remaining</TableCell><TableCell>Evidence</TableCell>
                  </TableRow></TableHead>
                  <TableBody>{estimate.cohorts.map((cohort) => (
                    <TableRow key={cohort.publicationItemId}>
                      <TableCell>
                        <Typography variant="body2">{cohort.productName}</Typography>
                        <Typography variant="caption" color="text.secondary">{cohort.productLine} · SKU {cohort.sku} · publication item {cohort.publicationItemId}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{date(cohort.confirmedAt)}</Typography>
                        <Typography variant="caption" color="text.secondary">provider live window {cohort.publishingAt ? `${date(cohort.publishingAt)} to ` : "ending "}{date(cohort.confirmedAt)}</Typography>
                      </TableCell>
                      <TableCell align="right">
                        {unitLabel(cohort.quantity)} / {cohort.estimatedSoldQuantity === null ? "Unavailable" : unitLabel(cohort.estimatedSoldQuantity)} / {cohort.estimatedRemainingAtCutoff === null ? "Unavailable" : unitLabel(cohort.estimatedRemainingAtCutoff)}
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" component="div">Date: {cohort.dateProvenance === "recorded_confirmation" ? "recorded confirmation" : "unknown"} · assignment: {cohort.attributionProvenance === "estimated_closed_flow" ? "estimated FIFO" : "unavailable"}</Typography>
                        <Typography variant="caption" component="div">Forecast baseline: {cohort.forecastEvidenceProvenance}{cohort.forecastEvidence?.pricingModelVersion ? ` · model ${cohort.forecastEvidence.pricingModelVersion}` : ""}</Typography>
                        {cohort.reasons.length > 0 && <Typography variant="caption" color="warning.main" component="div">Unavailable: {cohort.reasons.map(historicalReasonLabel).join("; ")}</Typography>}
                        {cohort.allocations.map((allocation) => (
                          <Typography key={`${allocation.orderId}:${allocation.orderedAt}`} variant="caption" color="text.secondary" component="div">
                            Order {allocation.orderNumber}: {unitLabel(allocation.quantity)} · listed at least {days(allocation.listedDaysLowerBound)}{allocation.listedDaysUpperBound === null ? "" : ` and at most ${days(allocation.listedDaysUpperBound)}`}
                          </Typography>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}
          {estimate.conflictCount > 0 && (
            <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 1 }}>
              {quantity(estimate.conflictCount)} SKU reconciliation conflict{estimate.conflictCount === 1 ? "" : "s"}: {estimate.conflicts.map((conflict) => `SKU ${conflict.sku} (${conflict.reasons.map(historicalReasonLabel).join(", ")})`).join("; ")}{estimate.conflicts.length < estimate.conflictCount ? "; additional conflicts omitted from this bounded view" : ""}.
            </Typography>
          )}
        </>
      )}
    </Box>
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
    nextSearchParams.set("historyPage", "1");
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

function Details({ report }: { report: Extract<InventorySellingHistoryReport, { status: "ready" }> }) {
  const shown = report.details.length;
  const total = report.detailTotal;
  return (
    <Box component="details" sx={{ mt: 2, maxWidth: "100%" }}>
      <Box component="summary" sx={{ cursor: "pointer", typography: "body2", color: "text.secondary" }}>
        Inspect publication lots and allocated orders ({shown === total ? `all ${quantity(shown)}` : `showing ${quantity(shown)} of ${quantity(total)}`})
      </Box>
      <TableContainer sx={{ mt: 1, overflowX: "auto" }}>
        <Table size="small" aria-label="Publication lot and order details">
          <TableHead>
            <TableRow>
              <TableCell>Lot</TableCell>
              <TableCell align="right">Published</TableCell>
              <TableCell align="right">Sold / removed / remaining</TableCell>
              <TableCell>Orders and forecast baseline</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.details.map((detail) => (
              <TableRow key={detail.episodeKey}>
                <TableCell>
                  <Typography variant="body2">{detail.productName}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {detail.productLine} · SKU {detail.sku} · receipt {detail.receiptId} · {statusLabel(detail.kind)}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2">{detail.listedAt ? date(detail.listedAt) : "Unknown"}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {detail.remainingAgeDays === null ? "Remaining age unavailable" : `Remaining age ${days(detail.remainingAgeDays)}`}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  {unitLabel(detail.soldQuantity)} / {unitLabel(detail.removedQuantity)} / {unitLabel(detail.ledgerRemainingQuantity)}
                  {detail.presenceUncertain && <Typography variant="caption" color="warning.main" component="div">Remaining presence uncertain</Typography>}
                </TableCell>
                <TableCell>
                  <Typography variant="caption" component="div">
                    Forecast baseline: {detail.forecastEvidenceProvenance}
                    {detail.forecastEvidence?.pricingModelVersion ? ` · model ${detail.forecastEvidence.pricingModelVersion}` : ""}
                    {detail.forecastEvidence?.estimatedTimeToSellDays !== undefined && detail.forecastEvidence.estimatedTimeToSellDays !== null ? ` · recorded estimate ${detail.forecastEvidence.estimatedTimeToSellDays.toFixed(1)} days` : ""}
                  </Typography>
                  {detail.orders.length ? detail.orders.map((order) => (
                    <Typography key={`${order.orderNumber}:${order.soldAt}`} variant="caption" color="text.secondary" component="div">
                      Order {order.orderNumber}: {unitLabel(order.quantity)} sold {date(order.soldAt)}{order.listedDays === null ? " · listed time unavailable" : ` · ${days(order.listedDays)} listed`}
                    </Typography>
                  )) : <Typography variant="caption" color="text.secondary">No allocated sale orders in this lot.</Typography>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function DetailPageControl({ page, pageCount }: { page: number; pageCount: number }) {
  const [searchParams, setSearchParams] = useSearchParams();
  return (
    <Stack direction="row" justifyContent="center" sx={{ mt: 1.5 }}>
      <Pagination
        count={pageCount}
        page={page}
        size="small"
        onChange={(_, nextPage) => {
          const nextSearchParams = new URLSearchParams(searchParams);
          nextSearchParams.set("historyPage", String(nextPage));
          setSearchParams(nextSearchParams);
        }}
      />
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
        <HistoricalPublicationHistory estimate={report.historicalPublicationEstimate} />
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
          No receipt-linked publication cohorts are available in this analysis window. Historical uploads may still appear below.
        </Typography>
      ) : (
        <>
          <Box sx={{ mt: 2 }}><Summary summary={report.overall} /></Box>
          <SellThrough summary={report.overall} />
          <ProductLines report={report} />
          <Details report={report} />
          {report.detailPageCount > 1 && (
            <DetailPageControl
              page={report.detailPage}
              pageCount={report.detailPageCount}
            />
          )}
        </>
      )}
      <HistoricalPublicationHistory estimate={report.historicalPublicationEstimate} />
      <Coverage report={report} />
    </Paper>
  );
}
