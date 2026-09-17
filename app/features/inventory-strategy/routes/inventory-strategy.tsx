import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import { useEffect, useMemo } from "react";
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
  inventoryPublicationSettingsRepository,
  inventoryStrategyTurnaroundRepository,
  pricingConfigRepository,
} from "~/core/db";
import { refreshContinuousPricingInventory } from "~/features/continuous-pricing/services/continuousInventoryRefresh.server";
import type { CapitalCycleEconomics } from "~/features/pricing/domain/capitalCycle";
import { CapitalTurnaround } from "../components/CapitalTurnaround";
import { HurdleSweep } from "../components/HurdleSweep";
import { InventorySellingHistory } from "../components/InventorySellingHistory";
import { StrategyVerdict } from "../components/StrategyVerdict";
import { STRATEGY_COST_BASIS } from "../components/verdict";
import { selectTurnaround } from "../domain/turnaroundStrategy";
import { loadInventoryStrategyDashboard } from "../services/inventoryStrategyDashboard.server";
import { loadInventorySellingHistory } from "../services/inventorySellingHistory.server";
import { loadReinvestmentTurnaroundWithRecovery } from "../services/reinvestmentTurnaround.server";
import { queueInventoryStrategyAnalysis } from "../services/inventoryStrategyAnalysis.server";
import {
  DEFAULT_SELLING_HISTORY_SCOPE,
  SELLING_HISTORY_WINDOWS,
  type SellingHistoryScope,
} from "../types/inventorySellingHistory";
import type { TurnaroundMode } from "../types/turnaroundStrategy";

type ActionData =
  | { success: true; message: string }
  | { success: false; error: string };

export const meta: MetaFunction = () => [
  { title: "Inventory Strategy" },
  {
    name: "description",
    content: "Choose the pricing hurdle and see how fast capital turns.",
  },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const searchParams = new URL(request.url).searchParams;
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
  const [dashboard, recentBatches, sellingHistoryResult, reinvestmentResult, turnaroundSettingsResult] = await Promise.all([
    loadInventoryStrategyDashboard(settings.sellerKey, pricingConfig),
    settings.sellerKey
      ? inventoryBatchesRepository.findRecent({
          sourceTypes: ["strategy"],
          limit: 10,
        })
      : [],
    loadInventorySellingHistory(settings.sellerKey, { scope: historyScope })
      .then((report) => ({ report, error: null }))
      .catch((error) => {
        console.error("Inventory selling history load failed", error);
        return {
          report: null,
          error: "Selling history could not be loaded. Existing strategy analysis is still available.",
        };
      }),
    loadReinvestmentTurnaroundWithRecovery(settings.sellerKey),
    inventoryStrategyTurnaroundRepository.findForSeller(settings.sellerKey)
      .then((turnaroundSettings) => ({ turnaroundSettings, error: null }))
      .catch((error) => {
        console.error("Inventory Strategy turnaround settings load failed", error);
        return { turnaroundSettings: [], error: "Saved turnaround settings could not be loaded; using the 28-day manual fallback." };
      }),
  ]);
  const latestAnalysis =
    recentBatches.find((batch) => batch.sourceLabel === settings.sellerKey) ??
    null;

  return data({
    settings,
    dashboard,
    latestAnalysis,
    sellingHistoryResult,
    reinvestmentResult,
    turnaroundSettingsResult,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const payload = (await request.json()) as {
      intent?: string;
      sellerKey?: string;
      mode?: TurnaroundMode;
      manualTurnaroundDays?: number;
    };
    const configuration = await inventoryPublicationSettingsRepository.get();
    const settings = configuration.settings.continuousPricing;
    if (!settings.sellerKey) {
      return data<ActionData>(
        { success: false, error: "Configure a seller key first." },
        { status: 400 },
      );
    }

    if (payload.intent === "save_turnaround") {
      if (payload.sellerKey !== settings.sellerKey ||
          (payload.mode !== "manual" && payload.mode !== "observed") ||
          typeof payload.manualTurnaroundDays !== "number") {
        return data<ActionData>({ success: false, error: "Turnaround settings are invalid or stale." }, { status: 400 });
      }
      await inventoryStrategyTurnaroundRepository.saveForConfiguredSeller({
        sellerKey: payload.sellerKey,
        productLineId: null,
        mode: payload.mode,
        manualTurnaroundDays: payload.manualTurnaroundDays,
      });
      return data<ActionData>({ success: true, message: "Saved the turnaround source and manual days." });
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
  const {
    settings,
    dashboard,
    latestAnalysis,
    sellingHistoryResult,
    reinvestmentResult,
    turnaroundSettingsResult,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetcher = useFetcher<ActionData>();
  const analysisFetcher = useFetcher<{
    batchNumber?: number;
    status?: string;
  }>();
  const { revalidate } = useRevalidator();
  const sellerTurnaround = useMemo(
    () => selectTurnaround(dashboard.sellerKey, null, turnaroundSettingsResult.turnaroundSettings,
      reinvestmentResult.report, reinvestmentResult.error),
    [dashboard.sellerKey, reinvestmentResult.error, reinvestmentResult.report, turnaroundSettingsResult.turnaroundSettings],
  );
  const economics = useMemo<CapitalCycleEconomics>(
    () => ({
      ...STRATEGY_COST_BASIS,
      relativeOverhead: dashboard.profitPerDay.relativeOverhead,
      staticOverheadPerUnit: dashboard.profitPerDay.staticOverheadPerUnit,
      turnaroundDays: sellerTurnaround.effectiveDays,
    }),
    [dashboard.profitPerDay, sellerTurnaround.effectiveDays],
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
    intent: "refresh_inventory" | "queue_analysis" | "save_turnaround",
    details: { sellerKey?: string; mode?: TurnaroundMode; manualTurnaroundDays?: number } = {},
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
            Which hurdle to price at, how fast capital turns, and how fast
            inventory sells. Prices are published only by the pricing workflow.
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

      <StrategyVerdict dashboard={dashboard} economics={economics} />
      <HurdleSweep dashboard={dashboard} />
      <CapitalTurnaround
        selection={sellerTurnaround}
        busy={busy || !settings.sellerKey}
        error={reinvestmentResult.error}
        settingsError={turnaroundSettingsResult.error}
        onSave={(mode, manualTurnaroundDays) =>
          submit("save_turnaround", { sellerKey: dashboard.sellerKey, mode, manualTurnaroundDays })}
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
    </Box>
  );
}
