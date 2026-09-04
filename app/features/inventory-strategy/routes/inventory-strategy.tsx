import { Alert, Box, Button, Stack, Typography } from "@mui/material";
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
import type { CapitalCycleEconomics } from "~/features/pricing/domain/capitalCycle";
import { DEFAULT_CAPITAL_CYCLE_INPUTS } from "../components/capitalCycleInputs";
import { ForecastGrading } from "../components/ForecastGrading";
import { HorizonCurve } from "../components/HorizonCurve";
import { HurdleSweep } from "../components/HurdleSweep";
import { PercentileExplorer } from "../components/PercentileExplorer";
import { PolicyComparison } from "../components/PolicyComparison";
import { StrategyVerdict } from "../components/StrategyVerdict";
import { loadForecastGrading } from "../services/forecastGrading.server";
import { loadInventoryStrategyDashboard } from "../services/inventoryStrategyDashboard.server";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";
import { DEFAULT_FORECAST_GRADING_HORIZON_DAYS } from "../types/inventoryStrategy";

type ActionData =
  | { success: true; message: string }
  | { success: false; error: string };

export const meta: MetaFunction = () => [
  { title: "Inventory Strategy" },
  {
    name: "description",
    content:
      "Judge the active pricing policy against its alternatives and the forecasts behind it.",
  },
];

export async function loader() {
  const [publicationConfiguration, pricingConfig] = await Promise.all([
    inventoryPublicationSettingsRepository.get(),
    pricingConfigRepository.get(),
  ]);
  const settings = publicationConfiguration.settings.continuousPricing;
  const [dashboard, recentBatches, forecastGrading] = await Promise.all([
    loadInventoryStrategyDashboard(settings.sellerKey, pricingConfig),
    settings.sellerKey
      ? inventoryBatchesRepository.findRecent({
          sourceTypes: ["strategy"],
          limit: 10,
        })
      : [],
    loadForecastGrading(settings.sellerKey),
  ]);
  const latestAnalysis =
    recentBatches.find((batch) => batch.sourceLabel === settings.sellerKey) ??
    null;

  return data({ settings, dashboard, latestAnalysis, forecastGrading });
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

export default function InventoryStrategyRoute() {
  const { settings, dashboard, latestAnalysis, forecastGrading } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const analysisFetcher = useFetcher<{
    batchNumber?: number;
    status?: string;
  }>();
  const { revalidate } = useRevalidator();
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
            Judge the active pricing policy against its alternatives and check
            the forecasts behind it. Nothing here changes configuration or
            publishes prices.
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

      <StrategyVerdict
        dashboard={dashboard}
        economics={economics}
        grading={
          forecastGrading.find(
            (report) =>
              report.horizonDays === DEFAULT_FORECAST_GRADING_HORIZON_DAYS,
          ) ?? forecastGrading[0]
        }
      />
      <ForecastGrading
        reports={forecastGrading}
        policyMethod={dashboard.policy.method}
      />
      <PolicyComparison comparisons={dashboard.overall.policyComparisons} />
      <HurdleSweep dashboard={dashboard} />
      <HorizonCurve
        dashboard={dashboard}
        economics={economics}
        cycleInputs={cycleInputs}
        onCycleInputsChange={setCycleInputs}
      />
      <PercentileExplorer dashboard={dashboard} />

      <Alert severity="info" sx={{ mt: 3 }}>
        Expected wait estimates the next sale/listing position, not liquidation
        of every unit. Median and P75 are weighted by your current unit
        quantities.
      </Alert>
    </Box>
  );
}
