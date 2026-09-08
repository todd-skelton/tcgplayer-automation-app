import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import {
  data,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import {
  inventoryBatchesRepository,
  forecastEvaluationsRepository,
  inventoryPublicationSettingsRepository,
  pricingConfigRepository,
} from "~/core/db";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import { refreshContinuousPricingInventory } from "~/features/continuous-pricing/services/continuousInventoryRefresh.server";
import type { CapitalCycleEconomics } from "~/features/pricing/domain/capitalCycle";
import { DEFAULT_CAPITAL_CYCLE_INPUTS } from "../components/capitalCycleInputs";
import { ForecastGrading } from "../components/ForecastGrading";
import { HorizonCurve } from "../components/HorizonCurve";
import { InventorySellingHistory } from "../components/InventorySellingHistory";
import { HurdleSweep } from "../components/HurdleSweep";
import { PercentileExplorer } from "../components/PercentileExplorer";
import { PolicyComparison } from "../components/PolicyComparison";
import { StrategyVerdict } from "../components/StrategyVerdict";
import { loadForecastGrading } from "../services/forecastGrading.server";
import { loadInventoryStrategyDashboard } from "../services/inventoryStrategyDashboard.server";
import { loadInventorySellingHistory } from "../services/inventorySellingHistory.server";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";
import {
  DEFAULT_SELLING_HISTORY_SCOPE,
  SELLING_HISTORY_WINDOWS,
  type SellingHistoryScope,
} from "../types/inventorySellingHistory";

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

export async function loader({ request }: LoaderFunctionArgs) {
  const searchParams = new URL(request.url).searchParams;
  const requestedHistoryPage = Number.parseInt(
    searchParams.get("historyPage") ?? "1",
    10,
  );
  const historyPage = Number.isInteger(requestedHistoryPage)
    ? Math.max(1, requestedHistoryPage)
    : 1;
  const requestedWindowDays = Number.parseInt(
    searchParams.get("historyDays") ?? "",
    10,
  );
  const historyScope: SellingHistoryScope = {
    windowDays: SELLING_HISTORY_WINDOWS.includes(
      requestedWindowDays as SellingHistoryScope["windowDays"],
    )
      ? (requestedWindowDays as SellingHistoryScope["windowDays"])
      : DEFAULT_SELLING_HISTORY_SCOPE.windowDays,
    productLine: searchParams.get("historyProductLine")?.trim() || null,
  };
  const [publicationConfiguration, pricingConfig] = await Promise.all([
    inventoryPublicationSettingsRepository.get(),
    pricingConfigRepository.get(),
  ]);
  const settings = publicationConfiguration.settings.continuousPricing;
  const [dashboard, recentBatches, forecastGradingResult, sellingHistoryResult] = await Promise.all([
    loadInventoryStrategyDashboard(settings.sellerKey, pricingConfig),
    settings.sellerKey
      ? inventoryBatchesRepository.findRecent({
          sourceTypes: ["strategy"],
          limit: 10,
        })
      : [],
    loadForecastGrading(settings.sellerKey)
      .then((report) => ({ report, error: null }))
      .catch((error) => {
        console.error("Forecast validation load failed", error);
        return {
          report: null,
          error: "Forecast validation could not be loaded. Existing strategy analysis is still available.",
        };
      }),
    loadInventorySellingHistory(settings.sellerKey, {
      detailPage: historyPage,
      scope: historyScope,
    })
      .then((report) => ({ report, error: null }))
      .catch((error) => {
        console.error("Inventory selling history load failed", error);
        return {
          report: null,
          error: "Selling history could not be loaded. Existing strategy analysis is still available.",
        };
      }),
  ]);
  const latestAnalysis =
    recentBatches.find((batch) => batch.sourceLabel === settings.sellerKey) ??
    null;

  return data({
    settings,
    dashboard,
    latestAnalysis,
    forecastGrading: forecastGradingResult.report,
    forecastGradingError: forecastGradingResult.error,
    activeCorrection: pricingConfig.pricing.forecastCorrection,
    sellingHistoryResult,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const payload = (await request.json()) as {
      intent?: string;
      evaluationId?: string;
      correctionVersion?: string;
    };
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

    if (payload.intent === "activate_forecast_correction") {
      if (!payload.evaluationId) {
        return data<ActionData>({ success: false, error: "Select an eligible evaluation." }, { status: 400 });
      }
      await forecastEvaluationsRepository.activate({
        sellerKey: settings.sellerKey,
        evaluationId: payload.evaluationId,
        sourceModelVersion: `curve:${PRICING_MODEL_VERSION}`,
      });
      return data<ActionData>({ success: true, message: "Activated the held-out forecast correction for future pricing runs." });
    }

    if (payload.intent === "rollback_forecast_correction") {
      if (!payload.correctionVersion) {
        return data<ActionData>({ success: false, error: "No active correction was selected." }, { status: 400 });
      }
      await forecastEvaluationsRepository.rollback({
        sellerKey: settings.sellerKey,
        correctionVersion: payload.correctionVersion,
        reason: "inventory_strategy_user_request",
      });
      return data<ActionData>({ success: true, message: "Rolled back to the uncorrected pricing forecast." });
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
  const {
    settings,
    dashboard,
    latestAnalysis,
    forecastGrading,
    forecastGradingError,
    activeCorrection,
    sellingHistoryResult,
  } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
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

  const submit = (
    intent: "refresh_inventory" | "queue_analysis" | "activate_forecast_correction" | "rollback_forecast_correction",
    details: { evaluationId?: string; correctionVersion?: string } = {},
  ) =>
    fetcher.submit(
      { intent, ...details } as unknown as Parameters<typeof fetcher.submit>[0],
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
            the forecasts behind it. Eligible forecast corrections can be
            activated or rolled back here; prices are published only by the
            normal pricing workflow.
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
        grading={forecastGrading}
      />
      {navigation.state === "loading" ? (
        <LinearProgress aria-label="Loading selling history" sx={{ mb: 1 }} />
      ) : null}
      {sellingHistoryResult.error ? (
        <Alert severity="error" sx={{ mb: 3 }}>
          {sellingHistoryResult.error}
        </Alert>
      ) : sellingHistoryResult.report ? (
        <InventorySellingHistory report={sellingHistoryResult.report} />
      ) : null}
      {forecastGradingError ? (
        <Alert severity="error" sx={{ mb: 3 }}>
          {forecastGradingError}
        </Alert>
      ) : null}
      <ForecastGrading
        report={forecastGrading}
        activeCorrection={activeCorrection}
        busy={busy}
        onActivate={(evaluationId) => submit("activate_forecast_correction", { evaluationId })}
        onRollback={(correctionVersion) => submit("rollback_forecast_correction", { correctionVersion })}
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
