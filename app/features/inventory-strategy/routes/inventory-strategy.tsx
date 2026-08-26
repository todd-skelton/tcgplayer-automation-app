import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControl,
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
  inventoryStrategyRepository,
  pricingConfigRepository,
} from "~/core/db";
import { refreshContinuousPricingInventory } from "~/features/continuous-pricing/services/continuousInventoryRefresh.server";
import { buildInventoryStrategyDashboard } from "../services/inventoryStrategy";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";
import {
  INVENTORY_STRATEGY_PERCENTILES,
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
  if (configured !== null && findScenario(productLine, configured)) {
    return configured;
  }
  return 80;
}

export async function loader() {
  const [publicationConfiguration, pricingConfig] = await Promise.all([
    inventoryPublicationSettingsRepository.get(),
    pricingConfigRepository.get(),
  ]);
  const settings = publicationConfiguration.settings.continuousPricing;
  const [items, recentBatches] = settings.sellerKey
    ? await Promise.all([
        inventoryStrategyRepository.findSnapshot(settings.sellerKey),
        inventoryBatchesRepository.findRecent({
          sourceTypes: ["strategy"],
          limit: 10,
        }),
      ])
    : [[], []];
  const latestAnalysis =
    recentBatches.find((batch) => batch.sourceLabel === settings.sellerKey) ??
    null;

  return data({
    settings,
    dashboard: buildInventoryStrategyDashboard(
      settings.sellerKey,
      items,
      pricingConfig,
    ),
    latestAnalysis,
  });
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
  const revalidator = useRevalidator();
  const [selections, setSelections] = useState<Record<string, number>>({});
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
    if (fetcher.state === "idle" && fetcher.data?.success) {
      void revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  useEffect(() => {
    if (!analysisActive) return;
    const timer = setInterval(() => void revalidator.revalidate(), 5_000);
    return () => clearInterval(timer);
  }, [analysisActive, revalidator]);

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
          {latestAnalysis.status}
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
                  const options = Array.from(
                    new Set([
                      ...INVENTORY_STRATEGY_PERCENTILES,
                      ...(productLine.configuredPercentile === null
                        ? []
                        : [productLine.configuredPercentile]),
                    ]),
                  ).sort((left, right) => left - right);
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
                        </Stack>
                      </TableCell>
                      <TableCell align="center">
                        {productLine.configuredPercentile === null
                          ? "Skipped"
                          : formatPercentile(productLine.configuredPercentile)}
                      </TableCell>
                      <TableCell align="center">
                        <FormControl size="small" sx={{ minWidth: 100 }}>
                          <Select
                            value={percentile}
                            onChange={(event) =>
                              setSelections((current) => ({
                                ...current,
                                [productLine.key]: Number(event.target.value),
                              }))
                            }
                          >
                            {options.map((option) => (
                              <MenuItem key={option} value={option}>
                                {formatPercentile(option)}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
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
                  <TableCell colSpan={11} align="center">
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
            expected wait. The configured percentile is highlighted.
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
                {INVENTORY_STRATEGY_PERCENTILES.map((percentile) => (
                  <TableCell key={percentile} align="right">
                    {formatPercentile(percentile)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {[dashboard.overall, ...dashboard.productLines].map(
                (productLine) => (
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
                    {INVENTORY_STRATEGY_PERCENTILES.map((percentile) => {
                      const scenario = findScenario(productLine, percentile);
                      const configured =
                        productLine.configuredPercentile === percentile;
                      return (
                        <TableCell
                          key={percentile}
                          align="right"
                          sx={
                            configured
                              ? { bgcolor: "action.selected" }
                              : undefined
                          }
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
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ),
              )}
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
