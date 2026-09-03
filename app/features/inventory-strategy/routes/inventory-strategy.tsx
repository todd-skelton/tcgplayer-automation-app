import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Paper,
  Slider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import {
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type MetaFunction,
} from "react-router";
import {
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
  pricingConfigRepository,
} from "~/core/db";
import { refreshContinuousPricingInventory } from "~/features/continuous-pricing/services/continuousInventoryRefresh.server";
import {
  bestCapitalCycle,
  capitalCycleAtHorizon,
  type CapitalCycle,
  type CapitalCycleEconomics,
} from "~/features/pricing/domain/capitalCycle";
import {
  horizonGainElasticity,
  horizonKneeDays,
  horizonMarginalValuePerDay,
  horizonValue,
} from "~/features/pricing/domain/horizonValueCurve";
import {
  ValidatedNumberField,
  type NumberFieldDescriptor,
} from "~/shared/components/ValidatedNumberField";
import { loadInventoryStrategyDashboard } from "../services/inventoryStrategyDashboard.server";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";
import {
  INVENTORY_STRATEGY_HORIZON_DAYS,
  INVENTORY_STRATEGY_MAX_PERCENTILE,
  INVENTORY_STRATEGY_MIN_PERCENTILE,
  type InventoryStrategyProductLine,
  type InventoryStrategyScenario,
} from "../types/inventoryStrategy";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

type ActionData =
  | { success: true; message: string }
  | { success: false; error: string };

export const meta: MetaFunction = () => [
  { title: "Inventory Strategy" },
  {
    name: "description",
    content:
      "Compare listed inventory value and estimated selling time across pricing percentiles.",
  },
];

function formatPercentile(percentile: number): string {
  const remainder = percentile % 100;
  if (remainder >= 11 && remainder <= 13) return `${percentile}th`;
  if (percentile % 10 === 1) return `${percentile}st`;
  if (percentile % 10 === 2) return `${percentile}nd`;
  if (percentile % 10 === 3) return `${percentile}rd`;
  return `${percentile}th`;
}

function formatCoverage(modeled: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((modeled / total) * 100)}%`;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : "−"}${currencyFormatter.format(Math.abs(value))}`;
}

function formatAge(isoDate: string | null): string {
  if (!isoDate) return "No saved curve";
  const ageHours = Math.max(
    0,
    (Date.now() - new Date(isoDate).getTime()) / (60 * 60 * 1000),
  );
  if (ageHours < 1) return "Less than 1 hour";
  if (ageHours < 48) return `${Math.round(ageHours)} hours`;
  return `${Math.round(ageHours / 24)} days`;
}

const fitConfidenceColor = {
  high: "success",
  medium: "warning",
  low: "default",
  unavailable: "default",
} as const;

/** Cycle inputs the reader can vary; overhead comes from the profit-per-day settings. */
type CapitalCycleInputs = Pick<
  CapitalCycleEconomics,
  "costBasisShareOfMarket" | "costBasisDiscountPerUnit" | "turnaroundDays"
>;

const DEFAULT_CAPITAL_CYCLE_INPUTS: CapitalCycleInputs = {
  costBasisShareOfMarket: 0.72,
  costBasisDiscountPerUnit: 0.3,
  turnaroundDays: 28,
};

const CAPITAL_CYCLE_FIELDS: NumberFieldDescriptor<CapitalCycleInputs>[] = [
  {
    key: "costBasisShareOfMarket",
    label: "Cost basis share of market",
    step: 0.01,
    helperText: "Fraction of market value paid for inventory",
  },
  {
    key: "costBasisDiscountPerUnit",
    label: "Cost basis discount per unit",
    step: 0.01,
    helperText: "Dollars off the cost basis for every unit bought",
  },
  {
    key: "turnaroundDays",
    label: "Turnaround days",
    step: 1,
    helperText: "Days from a sale until the proceeds are relisted",
  },
];

function formatDays(days: number): string {
  const rounded = days >= 100 ? Math.round(days) : Math.round(days * 10) / 10;
  return `${rounded.toLocaleString()} days`;
}

const emphasisColor = {
  knee: "success.main",
  cycle: "info.main",
  active: "text.primary",
} as const;

function cyclePortfolio(productLine: InventoryStrategyProductLine) {
  return {
    marketValue: productLine.estimatedMarketValue,
    unitCount: productLine.unitCount,
  };
}

/** The product line's best cycle, or undefined without a curve or a profitable horizon. */
function productLineBestCycle(
  productLine: InventoryStrategyProductLine,
  economics: CapitalCycleEconomics,
): CapitalCycle | undefined {
  const model = productLine.horizonModel;
  return model?.curve
    ? bestCapitalCycle(
        model.curve,
        cyclePortfolio(productLine),
        economics,
        model,
      )
    : undefined;
}

function cycleSummary(
  overall: InventoryStrategyProductLine,
  cycle: CapitalCycle | undefined,
): string {
  if (!overall.horizonModel?.curve)
    return "All listed inventory has no horizon model yet.";
  if (!cycle)
    return "No profitable cycle on all listed inventory at these inputs.";
  if (cycle.dailyReturn === undefined)
    return "The best cycle on all listed inventory puts no capital at risk at these inputs, so it has no rate of return.";
  return `The best cycle on all listed inventory compounds capital at ${(cycle.dailyReturn * 100).toFixed(2)}% per day.`;
}

/**
 * Modeled value at one horizon with its marginal rate, elasticity, and the
 * profit per day of a capital cycle. Shows the horizon itself when it varies
 * by row (knee, best cycle, value-matched).
 */
function HorizonValueCell({
  productLine,
  horizonDays,
  economics,
  showDays = false,
  emphasis,
}: {
  productLine: InventoryStrategyProductLine;
  horizonDays: number | null;
  economics: CapitalCycleEconomics;
  showDays?: boolean;
  emphasis?: "active" | "knee" | "cycle";
}) {
  const model = productLine.horizonModel;
  if (!model?.curve || horizonDays === null) {
    return <TableCell align="right">—</TableCell>;
  }
  const outsideRange =
    horizonDays < model.minimumHorizonDays ||
    horizonDays > model.maximumHorizonDays;
  const cycle = capitalCycleAtHorizon(
    model.curve,
    cyclePortfolio(productLine),
    economics,
    horizonDays,
  );
  return (
    <TableCell
      align="right"
      sx={{ bgcolor: emphasis === "active" ? "action.selected" : undefined }}
    >
      {showDays && (
        <Typography
          variant="body2"
          fontWeight={700}
          color={emphasis ? emphasisColor[emphasis] : "text.primary"}
        >
          {formatDays(horizonDays)}
        </Typography>
      )}
      <Typography
        variant="body2"
        fontWeight={emphasis === "active" ? 700 : 400}
      >
        {currencyFormatter.format(horizonValue(model.curve, horizonDays))}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {currencyFormatter.format(
          horizonMarginalValuePerDay(model.curve, horizonDays),
        )}
        /day · e {horizonGainElasticity(model.curve, horizonDays).toFixed(2)}
      </Typography>
      <Typography
        variant="caption"
        display="block"
        color={cycle.profit >= 0 ? "text.secondary" : "error.main"}
      >
        {currencyFormatter.format(cycle.profitPerDay)}/day profit ·{" "}
        {currencyFormatter.format(cycle.netProceeds)} net
      </Typography>
      {outsideRange && (
        <Typography variant="caption" color="text.secondary" display="block">
          Outside curve range
        </Typography>
      )}
    </TableCell>
  );
}

function findScenario(
  productLine: InventoryStrategyProductLine,
  percentile: number,
): InventoryStrategyScenario | undefined {
  return productLine.scenarios.find(
    (scenario) => scenario.percentile === percentile,
  );
}

function defaultSelection(productLine: InventoryStrategyProductLine): number {
  const configured = productLine.configuredPercentile;
  if (configured !== null) {
    return Math.min(
      INVENTORY_STRATEGY_MAX_PERCENTILE,
      Math.max(INVENTORY_STRATEGY_MIN_PERCENTILE, configured),
    );
  }
  return 80;
}

function formatKneeEstimate(productLine: InventoryStrategyProductLine): string {
  if (productLine.estimatedPercentile === null) {
    return "Estimate unavailable";
  }
  const estimate = formatPercentile(productLine.estimatedPercentile);
  if (
    productLine.kneeRangeMinimum === null ||
    productLine.kneeRangeMaximum === null ||
    productLine.kneeRangeMinimum === productLine.kneeRangeMaximum
  ) {
    return `Estimated ${estimate}`;
  }
  return `Estimated ${estimate} · ${formatPercentile(productLine.kneeRangeMinimum)}–${formatPercentile(productLine.kneeRangeMaximum)} range`;
}

export async function loader() {
  const [publicationConfiguration, pricingConfig] = await Promise.all([
    inventoryPublicationSettingsRepository.get(),
    pricingConfigRepository.get(),
  ]);
  const settings = publicationConfiguration.settings.continuousPricing;
  const [dashboard, recentBatches] = await Promise.all([
    loadInventoryStrategyDashboard(settings.sellerKey, pricingConfig),
    settings.sellerKey
      ? inventoryBatchesRepository.findRecent({
          sourceTypes: ["strategy"],
          limit: 10,
        })
      : [],
  ]);
  const latestAnalysis =
    recentBatches.find((batch) => batch.sourceLabel === settings.sellerKey) ??
    null;

  return data({ settings, dashboard, latestAnalysis });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const payload = (await request.json()) as { intent?: string };
    const configuration = await inventoryPublicationSettingsRepository.get();
    const settings = configuration.settings.continuousPricing;
    if (!settings.sellerKey) {
      return data<ActionData>(
        { success: false, error: "Configure a seller key first." },
        { status: 400 },
      );
    }

    if (payload.intent === "refresh_inventory") {
      const count = await refreshContinuousPricingInventory(
        settings.sellerKey,
        settings.minimumIntervalMinutes,
      );
      return data<ActionData>({
        success: true,
        message: `Refreshed ${count.toLocaleString()} listed inventory SKUs.`,
      });
    }

    if (payload.intent === "queue_analysis") {
      const result = await queueInventoryStrategyAnalysis(settings.sellerKey);
      return data<ActionData>({
        success: true,
        message: result.created
          ? `Queued strategy analysis batch ${result.batch.batchNumber} for ${result.batch.itemCount.toLocaleString()} SKUs.`
          : `Strategy analysis batch ${result.batch.batchNumber} is already ${result.batch.status}.`,
      });
    }

    return data<ActionData>(
      { success: false, error: "Unsupported inventory strategy action." },
      { status: 400 },
    );
  } catch (error) {
    return data<ActionData>(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5" sx={{ my: 0.5 }}>
          {value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {detail}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function InventoryStrategyRoute() {
  const { settings, dashboard, latestAnalysis } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const analysisFetcher = useFetcher<{
    batchNumber?: number;
    status?: string;
  }>();
  const { revalidate } = useRevalidator();
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [cycleInputs, setCycleInputs] = useState(DEFAULT_CAPITAL_CYCLE_INPUTS);
  const economics = useMemo<CapitalCycleEconomics>(
    () => ({
      ...cycleInputs,
      relativeOverhead: dashboard.profitPerDay.relativeOverhead,
      staticOverheadPerUnit: dashboard.profitPerDay.staticOverheadPerUnit,
    }),
    [cycleInputs, dashboard.profitPerDay],
  );
  const busy = fetcher.state !== "idle";
  const analysisActive =
    latestAnalysis?.status === "queued" || latestAnalysis?.status === "pricing";

  useEffect(() => {
    setSelections(
      Object.fromEntries(
        dashboard.productLines.map((productLine) => [
          productLine.key,
          defaultSelection(productLine),
        ]),
      ),
    );
  }, [dashboard.generatedAt, dashboard.productLines]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) void revalidate();
  }, [fetcher.data, fetcher.state, revalidate]);

  // Poll only the analysis batch while it runs; the dashboard reloads once it ends.
  const analysisBatchNumber = analysisActive
    ? latestAnalysis?.batchNumber
    : undefined;
  const { load: pollAnalysis } = analysisFetcher;
  useEffect(() => {
    if (analysisBatchNumber === undefined) return;
    const timer = setInterval(
      () => pollAnalysis(`/api/inventory-batches/${analysisBatchNumber}`),
      5_000,
    );
    return () => clearInterval(timer);
  }, [analysisBatchNumber, pollAnalysis]);
  const polledStatus =
    analysisFetcher.data?.batchNumber === latestAnalysis?.batchNumber
      ? analysisFetcher.data?.status
      : undefined;
  useEffect(() => {
    if (polledStatus && polledStatus !== "queued" && polledStatus !== "pricing")
      void revalidate();
  }, [polledStatus, revalidate]);

  const selectedProductLines = useMemo(
    () =>
      dashboard.productLines.map((productLine) => {
        const percentile =
          selections[productLine.key] ?? defaultSelection(productLine);
        return {
          productLine,
          percentile,
          scenario: findScenario(productLine, percentile),
        };
      }),
    [dashboard.productLines, selections],
  );
  const selectedValue = selectedProductLines.reduce(
    (sum, selection) =>
      sum +
      (selection.scenario?.listedValue ??
        selection.productLine.currentPolicyValue),
    0,
  );
  const selectedDelta = selectedValue - dashboard.overall.currentPolicyValue;
  const allProductLines = useMemo(
    () => [dashboard.overall, ...dashboard.productLines],
    [dashboard.overall, dashboard.productLines],
  );
  const matrixPercentiles = useMemo(
    () =>
      Array.from(
        new Set(
          allProductLines.flatMap(
            (productLine) => productLine.matrixPercentiles,
          ),
        ),
      ).sort((left, right) => left - right),
    [allProductLines],
  );
  const activeHorizonDays =
    dashboard.policy.method === "target-horizon"
      ? dashboard.policy.horizonDays
      : null;
  const showValueMatchedColumn = allProductLines.some(
    (productLine) => productLine.valueMatchedHorizonDays !== null,
  );
  const bestCycles = useMemo(
    () =>
      Object.fromEntries(
        allProductLines.map((productLine) => [
          productLine.key,
          productLineBestCycle(productLine, economics),
        ]),
      ),
    [allProductLines, economics],
  );

  const submit = (intent: "refresh_inventory" | "queue_analysis") =>
    fetcher.submit(
      { intent } as unknown as Parameters<typeof fetcher.submit>[0],
      { method: "post", encType: "application/json" },
    );

  return (
    <Box sx={{ maxWidth: 1500, mx: "auto", p: 3 }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" component="h1" gutterBottom>
            Inventory Strategy
          </Typography>
          <Typography color="text.secondary">
            Preview how percentile changes affect listed value and the expected
            wait for a sale. Scenarios never change configuration or publish
            prices.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Button
            variant="outlined"
            disabled={busy || !settings.sellerKey}
            onClick={() => submit("refresh_inventory")}
          >
            Refresh inventory
          </Button>
          <Button
            variant="contained"
            disabled={
              busy || analysisActive || dashboard.overall.skuCount === 0
            }
            onClick={() => submit("queue_analysis")}
          >
            Queue fresh analysis
          </Button>
        </Stack>
      </Stack>

      {!settings.sellerKey && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Configure the continuous-pricing seller key before loading inventory.
        </Alert>
      )}
      {fetcher.data && (
        <Alert
          severity={fetcher.data.success ? "success" : "error"}
          sx={{ mb: 2 }}
        >
          {fetcher.data.success ? fetcher.data.message : fetcher.data.error}
        </Alert>
      )}
      {latestAnalysis && (
        <Alert
          severity={
            analysisActive
              ? "info"
              : latestAnalysis.status === "failed"
                ? "error"
                : "success"
          }
          sx={{ mb: 2 }}
        >
          Latest analysis: batch {latestAnalysis.batchNumber} is{" "}
          {polledStatus ?? latestAnalysis.status}
          {latestAnalysis.lastPricedAt
            ? ` · completed ${new Date(latestAnalysis.lastPricedAt).toLocaleString()}`
            : ""}
        </Alert>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr",
            sm: "repeat(2, 1fr)",
            lg: "repeat(4, 1fr)",
          },
          gap: 2,
          mb: 3,
        }}
      >
        <MetricCard
          label="Actual listed value"
          value={currencyFormatter.format(dashboard.overall.currentListedValue)}
          detail={`${dashboard.overall.unitCount.toLocaleString()} units across ${dashboard.overall.skuCount.toLocaleString()} SKUs`}
        />
        <MetricCard
          label="Current-policy model"
          value={currencyFormatter.format(dashboard.overall.currentPolicyValue)}
          detail="Configured percentile per product line, with price floors applied"
        />
        <MetricCard
          label="Selected scenario"
          value={currencyFormatter.format(selectedValue)}
          detail={`${formatDelta(selectedDelta)} versus the current-policy model`}
        />
        <MetricCard
          label="Modeled unit coverage"
          value={formatCoverage(
            dashboard.overall.modeledUnitCount,
            dashboard.overall.unitCount,
          )}
          detail={`${dashboard.overall.modeledSkuCount.toLocaleString()} of ${dashboard.overall.skuCount.toLocaleString()} SKUs have a saved curve`}
        />
      </Box>

      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2 }}>
          <Typography variant="h6">Policy comparison</Typography>
          <Typography variant="body2" color="text.secondary">
            The active policy supplies continuous-pricing candidates; benchmark
            and calibration rows are read-only. One-copy value is the
            calibration basis; physical value keeps actual quantities.
          </Typography>
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Policy</TableCell>
                <TableCell align="right">One-copy value</TableCell>
                <TableCell align="right">Physical value</TableCell>
                <TableCell align="right">Median / P90 wait</TableCell>
                <TableCell align="right">Raised / lowered / held</TableCell>
                <TableCell align="right">Modeled SKUs</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {dashboard.overall.policyComparisons.map((comparison) => (
                <TableRow key={comparison.key}>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">
                        {comparison.label}
                      </Typography>
                      {comparison.role !== "current" && (
                        <Chip
                          size="small"
                          color={
                            comparison.role === "active"
                              ? "success"
                              : comparison.planState === "mixed"
                                ? "warning"
                                : "default"
                          }
                          variant="outlined"
                          label={
                            comparison.role === "active"
                              ? "Active"
                              : comparison.role === "benchmark"
                                ? "Benchmark"
                                : comparison.planState === "mixed"
                                  ? "Mixed plans"
                                  : comparison.matchStatus
                                    ? `Calibration · ${comparison.matchStatus}`
                                    : "Calibration"
                          }
                        />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(comparison.oneCopyValue)}
                  </TableCell>
                  <TableCell align="right">
                    {currencyFormatter.format(comparison.physicalValue)}
                  </TableCell>
                  <TableCell align="right">
                    {comparison.estimatedTime
                      ? `${comparison.estimatedTime.medianDays.toFixed(1)} / ${comparison.estimatedTime.p90Days.toFixed(1)} days`
                      : "N/A"}
                  </TableCell>
                  <TableCell align="right">
                    {comparison.raisedCount} / {comparison.loweredCount} /{" "}
                    {comparison.heldCount}
                  </TableCell>
                  <TableCell align="right">
                    {comparison.modeledSkuCount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2 }}>
          <Typography variant="h6">Horizon curve</Typography>
          <Typography variant="body2" color="text.secondary">
            Physical value across target horizons follows a fitted log-logistic
            curve: floor plus headroom ÷ (1 + (midpoint ÷ horizon)^steepness).
            The knee is where gain per doubling of horizon decelerates fastest,
            at about 79% of headroom. Each cell shows modeled value, dollars per
            extra day, and elasticity (percent of gain over floor earned per
            percent longer horizon). Fit residual is the root-mean-square error
            in headroom fraction.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Profit per day takes overhead off the sale, recovers the cost basis,
            and divides by horizon plus turnaround. Best cycle is the horizon
            that maximizes it. Overhead comes from the profit-per-day settings.
            Horizons shorter than most SKUs&apos; fastest sell time overstate
            how quickly a cycle completes.
          </Typography>
          <Stack
            direction="row"
            spacing={2}
            flexWrap="wrap"
            useFlexGap
            sx={{ mt: 2 }}
          >
            {CAPITAL_CYCLE_FIELDS.map((field) => (
              <ValidatedNumberField
                key={field.key}
                size="small"
                label={field.label}
                value={cycleInputs[field.key]}
                step={field.step}
                helperText={field.helperText}
                isValid={(value) => value >= 0}
                onCommit={(value) =>
                  setCycleInputs((current) => ({
                    ...current,
                    [field.key]: value,
                  }))
                }
              />
            ))}
          </Stack>
          <Typography variant="body2" sx={{ mt: 2 }}>
            {cycleSummary(dashboard.overall, bestCycles[dashboard.overall.key])}{" "}
            The default profit-per-day hurdle is configured at{" "}
            {(dashboard.profitPerDay.dailyReturnHurdle * 100).toFixed(2)}% per
            day.
          </Typography>
        </Box>
        <TableContainer>
          <Table size="small" sx={{ minWidth: 1200 }}>
            <TableHead>
              <TableRow>
                <TableCell
                  sx={{
                    position: "sticky",
                    left: 0,
                    bgcolor: "background.paper",
                    zIndex: 1,
                  }}
                >
                  Product line
                </TableCell>
                <TableCell>Fit</TableCell>
                <TableCell align="right">Floor → ceiling</TableCell>
                <TableCell align="right">Knee</TableCell>
                <TableCell align="right">Best cycle</TableCell>
                {activeHorizonDays !== null && (
                  <TableCell align="right">
                    Active ({formatDays(activeHorizonDays)})
                  </TableCell>
                )}
                {showValueMatchedColumn && (
                  <TableCell align="right">Value-matched</TableCell>
                )}
                {INVENTORY_STRATEGY_HORIZON_DAYS.map((horizonDays) => (
                  <TableCell key={horizonDays} align="right">
                    {horizonDays} days
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {allProductLines.map((productLine) => {
                const model = productLine.horizonModel;
                const curve = model?.curve ?? null;
                return (
                  <TableRow key={productLine.key}>
                    <TableCell
                      sx={{
                        position: "sticky",
                        left: 0,
                        bgcolor: "background.paper",
                        zIndex: 1,
                        fontWeight: productLine.key === "all" ? 700 : 400,
                      }}
                    >
                      {productLine.productLine}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={
                          model
                            ? fitConfidenceColor[model.fitConfidence]
                            : "default"
                        }
                        label={
                          !model
                            ? "No curve"
                            : !curve
                              ? "No fit"
                              : `${model.fitConfidence} confidence`
                        }
                      />
                      {curve && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          display="block"
                        >
                          midpoint {formatDays(curve.midpointDays)} · steepness{" "}
                          {curve.steepness.toFixed(2)} · residual{" "}
                          {curve.residual.toFixed(3)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {model && curve ? (
                        <>
                          <Typography variant="body2">
                            {currencyFormatter.format(curve.floorValue)} →{" "}
                            {currencyFormatter.format(curve.ceilingValue)}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                          >
                            {formatDays(model.minimumHorizonDays)} –{" "}
                            {formatDays(model.maximumHorizonDays)}
                          </Typography>
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <HorizonValueCell
                      productLine={productLine}
                      horizonDays={curve ? horizonKneeDays(curve) : null}
                      economics={economics}
                      showDays
                      emphasis="knee"
                    />
                    <HorizonValueCell
                      productLine={productLine}
                      horizonDays={
                        bestCycles[productLine.key]?.horizonDays ?? null
                      }
                      economics={economics}
                      showDays
                      emphasis="cycle"
                    />
                    {activeHorizonDays !== null && (
                      <HorizonValueCell
                        productLine={productLine}
                        horizonDays={activeHorizonDays}
                        economics={economics}
                        emphasis="active"
                      />
                    )}
                    {showValueMatchedColumn && (
                      <HorizonValueCell
                        productLine={productLine}
                        horizonDays={productLine.valueMatchedHorizonDays}
                        economics={economics}
                        showDays
                      />
                    )}
                    {INVENTORY_STRATEGY_HORIZON_DAYS.map((horizonDays) => (
                      <HorizonValueCell
                        key={horizonDays}
                        productLine={productLine}
                        horizonDays={horizonDays}
                        economics={economics}
                      />
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2 }}>
          <Typography variant="h6">Scenario builder</Typography>
          <Typography variant="body2" color="text.secondary">
            Unmodeled SKUs remain at their actual listed price. Value changes
            are compared with the current configured policy, not stale live
            prices.
          </Typography>
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Product line</TableCell>
                <TableCell align="center">Configured</TableCell>
                <TableCell align="center">Scenario</TableCell>
                <TableCell align="right">Units</TableCell>
                <TableCell align="right">Actual value</TableCell>
                <TableCell align="right">Policy value</TableCell>
                <TableCell align="right">Scenario value</TableCell>
                <TableCell align="right">Value change</TableCell>
                <TableCell align="right">Expected wait</TableCell>
                <TableCell align="right">Knee score</TableCell>
                <TableCell align="right">Coverage</TableCell>
                <TableCell align="right">Oldest curve</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {selectedProductLines.map(
                ({ productLine, percentile, scenario }) => {
                  const currentPolicyScenario =
                    productLine.configuredPercentile === null
                      ? undefined
                      : findScenario(
                          productLine,
                          productLine.configuredPercentile,
                        );
                  const medianDayDelta =
                    scenario?.estimatedTime &&
                    currentPolicyScenario?.estimatedTime
                      ? scenario.estimatedTime.medianDays -
                        currentPolicyScenario.estimatedTime.medianDays
                      : null;
                  return (
                    <TableRow key={productLine.key} hover>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2">
                            {productLine.productLine}
                          </Typography>
                          {!productLine.pricingEligible && (
                            <Chip size="small" label="Analysis only" />
                          )}
                          {productLine.estimatedPercentile !== null && (
                            <Chip
                              size="small"
                              color="success"
                              variant="outlined"
                              label={formatKneeEstimate(productLine)}
                            />
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell align="center">
                        {productLine.configuredPercentile === null
                          ? "Skipped"
                          : formatPercentile(productLine.configuredPercentile)}
                      </TableCell>
                      <TableCell align="center">
                        <Stack
                          direction="row"
                          spacing={1.5}
                          alignItems="center"
                          sx={{ minWidth: 220 }}
                        >
                          <Slider
                            aria-label={`${productLine.productLine} scenario percentile`}
                            min={INVENTORY_STRATEGY_MIN_PERCENTILE}
                            max={INVENTORY_STRATEGY_MAX_PERCENTILE}
                            step={1}
                            value={percentile}
                            valueLabelDisplay="auto"
                            valueLabelFormat={formatPercentile}
                            onChange={(_, value) =>
                              setSelections((current) => ({
                                ...current,
                                [productLine.key]: Array.isArray(value)
                                  ? value[0]
                                  : value,
                              }))
                            }
                          />
                          <Box sx={{ minWidth: 54, textAlign: "right" }}>
                            <Typography variant="body2" fontWeight={700}>
                              {formatPercentile(percentile)}
                            </Typography>
                            {(scenario?.interpolatedUnitCount ?? 0) > 0 && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {scenario?.interpolatedUnitCount.toLocaleString()}{" "}
                                units interpolated
                              </Typography>
                            )}
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        {productLine.unitCount.toLocaleString()}
                      </TableCell>
                      <TableCell align="right">
                        {currencyFormatter.format(
                          productLine.currentListedValue,
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {currencyFormatter.format(
                          productLine.currentPolicyValue,
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {currencyFormatter.format(
                          scenario?.listedValue ??
                            productLine.currentPolicyValue,
                        )}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          color:
                            (scenario?.deltaFromCurrentPolicy ?? 0) > 0
                              ? "success.main"
                              : (scenario?.deltaFromCurrentPolicy ?? 0) < 0
                                ? "error.main"
                                : "text.primary",
                        }}
                      >
                        {formatDelta(scenario?.deltaFromCurrentPolicy ?? 0)}
                      </TableCell>
                      <TableCell align="right">
                        {scenario?.estimatedTime
                          ? `${scenario.estimatedTime.medianDays.toFixed(1)}d median · ${scenario.estimatedTime.p75Days.toFixed(1)}d P75 · ${scenario.estimatedTime.p90Days.toFixed(1)}d P90${medianDayDelta === null ? "" : ` · ${medianDayDelta >= 0 ? "+" : ""}${medianDayDelta.toFixed(1)}d`}`
                          : "Not modeled"}
                      </TableCell>
                      <TableCell align="right">
                        {scenario?.kneeScore === null ||
                        scenario?.kneeScore === undefined
                          ? "—"
                          : scenario.kneeScore.toFixed(3)}
                      </TableCell>
                      <TableCell align="right">
                        {formatCoverage(
                          scenario?.modeledUnitCount ?? 0,
                          productLine.unitCount,
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {formatAge(productLine.oldestPricingAt)}
                      </TableCell>
                    </TableRow>
                  );
                },
              )}
              {dashboard.productLines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} align="center">
                    Refresh inventory to populate the strategy dashboard.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper variant="outlined">
        <Box sx={{ p: 2 }}>
          <Typography variant="h6">Full percentile matrix</Typography>
          <Typography variant="body2" color="text.secondary">
            Each cell shows guarded listed value and unit-weighted median
            expected wait. Knee score is normalized value minus normalized time;
            the outlined cell is the stable estimated recommendation.
          </Typography>
        </Box>
        <TableContainer>
          <Table size="small" sx={{ minWidth: 1200 }}>
            <TableHead>
              <TableRow>
                <TableCell
                  sx={{
                    position: "sticky",
                    left: 0,
                    bgcolor: "background.paper",
                    zIndex: 1,
                  }}
                >
                  Product line
                </TableCell>
                {matrixPercentiles.map((percentile) => (
                  <TableCell key={percentile} align="right">
                    {formatPercentile(percentile)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {allProductLines.map((productLine) => (
                <TableRow key={productLine.key}>
                  <TableCell
                    sx={{
                      position: "sticky",
                      left: 0,
                      bgcolor: "background.paper",
                      zIndex: 1,
                      fontWeight: productLine.key === "all" ? 700 : 400,
                    }}
                  >
                    {productLine.productLine}
                  </TableCell>
                  {matrixPercentiles.map((percentile) => {
                    const scenario = findScenario(productLine, percentile);
                    const configured =
                      productLine.configuredPercentile === percentile;
                    const estimated =
                      productLine.estimatedPercentile === percentile;
                    const mathematical =
                      productLine.mathematicalKneePercentile === percentile;
                    return (
                      <TableCell
                        key={percentile}
                        align="right"
                        sx={{
                          bgcolor: configured ? "action.selected" : undefined,
                          outline: estimated ? "2px solid" : undefined,
                          outlineColor: estimated ? "success.main" : undefined,
                          outlineOffset: estimated ? "-2px" : undefined,
                        }}
                      >
                        <Typography
                          variant="body2"
                          fontWeight={configured ? 700 : 400}
                        >
                          {scenario
                            ? currencyFormatter.format(scenario.listedValue)
                            : "—"}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {scenario?.estimatedTime
                            ? `${scenario.estimatedTime.medianDays.toFixed(1)} days`
                            : "No time estimate"}
                        </Typography>
                        <Typography
                          variant="caption"
                          display="block"
                          color={estimated ? "success.main" : "text.secondary"}
                          fontWeight={estimated ? 700 : 400}
                        >
                          {scenario?.kneeScore === null ||
                          scenario?.kneeScore === undefined
                            ? "No knee score"
                            : `Score ${scenario.kneeScore.toFixed(3)}`}
                          {estimated ? " · Estimated" : ""}
                          {mathematical && !estimated ? " · Math knee" : ""}
                          {(scenario?.interpolatedUnitCount ?? 0) > 0
                            ? " · Interpolated"
                            : ""}
                        </Typography>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Alert severity="info" sx={{ mt: 3 }}>
        Expected wait estimates the next sale/listing position, not liquidation
        of every unit. Median and P75 are weighted by your current unit
        quantities.
      </Alert>
    </Box>
  );
}
