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
import { ForecastGrading } from "../components/ForecastGrading";
import { HorizonCurve } from "../components/HorizonCurve";
import { HurdleSweep } from "../components/HurdleSweep";
import { MetricCard } from "../components/MetricCard";
import { PercentileMatrix } from "../components/PercentileMatrix";
import { PolicyComparison } from "../components/PolicyComparison";
import { ScenarioBuilder } from "../components/ScenarioBuilder";
import {
  currencyFormatter,
  formatCoverage,
  formatDelta,
} from "../components/format";
import {
  defaultSelection,
  findScenario,
} from "../components/scenarioSelection";
import { loadForecastGrading } from "../services/forecastGrading.server";
import { loadInventoryStrategyDashboard } from "../services/inventoryStrategyDashboard.server";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";

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

      <PolicyComparison comparisons={dashboard.overall.policyComparisons} />
      <HurdleSweep dashboard={dashboard} />
      <HorizonCurve dashboard={dashboard} />
      <ScenarioBuilder
        selections={selectedProductLines}
        onSelect={(key, percentile) =>
          setSelections((current) => ({ ...current, [key]: percentile }))
        }
      />
      <PercentileMatrix productLines={allProductLines} />
      <ForecastGrading
        reports={forecastGrading}
        policyMethod={dashboard.policy.method}
      />

      <Alert severity="info" sx={{ mt: 3 }}>
        Expected wait estimates the next sale/listing position, not liquidation
        of every unit. Median and P75 are weighted by your current unit
        quantities.
      </Alert>
    </Box>
  );
}
