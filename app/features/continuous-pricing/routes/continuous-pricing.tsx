import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Pagination,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import {
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import {
  continuousPricingRepository,
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { refreshContinuousPricingInventory } from "../services/continuousInventoryRefresh.server";
import { runContinuousPricingSchedulerCycle } from "../services/continuousPricingScheduler.server";
import { normalizeContinuousPricingSettings } from "../services/continuousPricingSettings";
import type {
  ContinuousPricingInventoryState,
  ContinuousPricingSettings,
} from "../types/continuousPricing";

const INVENTORY_PAGE_SIZE = 50;
const RECENT_AUTOMATIC_BATCH_LIMIT = 25;
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCoverage(count: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((count / total) * 100)}%`;
}

function InventoryMetric({
  label,
  value,
  detail,
  detailColor = "text.secondary",
}: {
  label: string;
  value: string | number;
  detail: string;
  detailColor?: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
      <Stack spacing={0.5}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5">{value}</Typography>
        <Typography variant="caption" color={detailColor}>
          {detail}
        </Typography>
      </Stack>
    </Paper>
  );
}

function isInventoryState(
  value: string,
): value is ContinuousPricingInventoryState {
  return [
    "all",
    "enabled",
    "paused",
    "needs_review",
    "in_stock",
    "out_of_stock",
    "due",
  ].includes(value);
}

type ActionData =
  | { success: true; message: string }
  | { success: false; error: string };

export const meta: MetaFunction = () => [
  { title: "Continuous Pricing" },
  {
    name: "description",
    content:
      "Continuously refresh, schedule, price, and optionally publish seller inventory.",
  },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const configuration = await inventoryPublicationSettingsRepository.get();
  const settings = configuration.settings.continuousPricing;
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const requestedState = url.searchParams.get("state") ?? "all";
  const state = isInventoryState(requestedState) ? requestedState : "all";
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
  );
  const [status, inventory, recentBatches] = settings.sellerKey
    ? await Promise.all([
        continuousPricingRepository.getStatus(settings.sellerKey, settings),
        continuousPricingRepository.findPage({
          sellerKey: settings.sellerKey,
          search,
          state,
          page,
          pageSize: INVENTORY_PAGE_SIZE,
        }),
        inventoryBatchesRepository.findRecent({
          sourceTypes: ["continuous"],
          limit: RECENT_AUTOMATIC_BATCH_LIMIT,
        }),
      ])
    : [
        {
          settings,
          inventoryCount: 0,
          inStockSkuCount: 0,
          availableUnitCount: 0,
          currentInventoryValue: 0,
          currentMarketValue: 0,
          marketComparableMarketValue: 0,
          marketComparableListedValue: 0,
          marketValueSkuCount: 0,
          pricedInStockSkuCount: 0,
          pricedAwaitingPublicationCount: 0,
          pricedAwaitingPublicationUnitCount: 0,
          needsReviewCount: 0,
          enabledInStockCount: 0,
          dueCount: 0,
          oldestDueAt: null,
          lastRefreshAt: null,
          lastRefreshStatus: null,
          lastRefreshError: null,
        },
        { items: [], total: 0, page: 1, pageSize: INVENTORY_PAGE_SIZE },
        [],
      ];

  return data({ status, inventory, recentBatches, filters: { search, state } });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const configuration = await inventoryPublicationSettingsRepository.get();
    const current = configuration.settings.continuousPricing;

    if (payload.intent === "save") {
      const continuousPricing = normalizeContinuousPricingSettings(
        payload.settings,
      );
      if (continuousPricing.enabled && !continuousPricing.sellerKey) {
        return data<ActionData>(
          {
            success: false,
            error:
              "A seller key is required before continuous pricing can run.",
          },
          { status: 400 },
        );
      }
      await inventoryPublicationSettingsRepository.save({
        ...configuration.settings,
        continuousPricing,
      });
      return data<ActionData>({
        success: true,
        message: "Continuous pricing settings saved.",
      });
    }

    if (payload.intent === "refresh") {
      if (!current.sellerKey) {
        throw new Error("Save a seller key before refreshing inventory.");
      }
      const count = await refreshContinuousPricingInventory(
        current.sellerKey,
        current.minimumIntervalMinutes,
      );
      return data<ActionData>({
        success: true,
        message: `Refreshed ${count} seller inventory SKUs.`,
      });
    }

    if (payload.intent === "run") {
      const result = await runContinuousPricingSchedulerCycle();
      return data<ActionData>({
        success: true,
        message:
          result.status === "scheduled"
            ? `Queued batch ${result.batchNumber} with ${result.itemCount} SKUs.`
            : `Scheduler cycle completed: ${result.status}.`,
      });
    }

    if (payload.intent === "reprice_all") {
      if (!current.enabled || !current.sellerKey) {
        throw new Error("Enable continuous pricing before repricing inventory.");
      }
      const count = await continuousPricingRepository.makeEligibleInventoryDue(
        current.sellerKey,
      );
      const result = await runContinuousPricingSchedulerCycle();
      const schedulerMessage =
        result.status === "scheduled"
          ? `Queued batch ${result.batchNumber} with ${result.itemCount} SKUs.`
          : result.status === "backlogged"
            ? "The existing pricing queue will process the due inventory."
            : result.status === "refresh_failed"
              ? "The scheduler will retry after the inventory refresh recovers."
              : result.status === "idle"
                ? "No inventory is currently schedulable."
                : "The scheduler is currently disabled.";
      return data<ActionData>({
        success: true,
        message: `Marked ${count} eligible SKUs due. ${schedulerMessage}`,
      });
    }

    if (payload.intent === "set_enabled") {
      if (!current.sellerKey) {
        throw new Error("No continuous pricing seller is configured.");
      }
      const sku = Number(payload.sku);
      if (!Number.isInteger(sku) || sku <= 0) {
        throw new Error("A valid SKU is required.");
      }
      await continuousPricingRepository.setEnabled(
        current.sellerKey,
        sku,
        payload.enabled === true,
      );
      return data<ActionData>({
        success: true,
        message: `SKU ${sku} ${payload.enabled === true ? "enabled" : "paused"}.`,
      });
    }

    return data<ActionData>(
      { success: false, error: "Unsupported continuous pricing action." },
      { status: 400 },
    );
  } catch (error) {
    return data<ActionData>(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}

export default function ContinuousPricingRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [settings, setSettings] = useState<ContinuousPricingSettings>(
    loaderData.status.settings,
  );
  const [search, setSearch] = useState(loaderData.filters.search);
  const [inventoryState, setInventoryState] =
    useState<ContinuousPricingInventoryState>(loaderData.filters.state);

  useEffect(() => {
    setSettings(loaderData.status.settings);
    setSearch(loaderData.filters.search);
    setInventoryState(loaderData.filters.state);
  }, [
    loaderData.filters.search,
    loaderData.filters.state,
    loaderData.status.settings,
  ]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      void revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  const submit = (payload: {
    intent: string;
    settings?: ContinuousPricingSettings;
    sku?: number;
    enabled?: boolean;
  }) =>
    fetcher.submit(payload as unknown as Parameters<typeof fetcher.submit>[0], {
      method: "post",
      encType: "application/json",
    });
  const busy = fetcher.state !== "idle";
  const { status, inventory, recentBatches } = loaderData;
  const pageCount = Math.max(
    1,
    Math.ceil(inventory.total / inventory.pageSize),
  );
  const setInventoryParams = (
    nextSearch: string,
    nextState: ContinuousPricingInventoryState,
    page: number,
  ) => {
    const next = new URLSearchParams(searchParams);
    if (nextSearch.trim()) {
      next.set("q", nextSearch.trim());
    } else {
      next.delete("q");
    }
    if (nextState === "all") {
      next.delete("state");
    } else {
      next.set("state", nextState);
    }
    if (page === 1) {
      next.delete("page");
    } else {
      next.set("page", String(page));
    }
    setSearchParams(next);
  };
  const firstVisible =
    inventory.total === 0 ? 0 : (inventory.page - 1) * inventory.pageSize + 1;
  const lastVisible = Math.min(
    inventory.total,
    inventory.page * inventory.pageSize,
  );
  const marketDifferencePercentage =
    status.marketComparableMarketValue > 0
      ? ((status.marketComparableListedValue -
          status.marketComparableMarketValue) /
          status.marketComparableMarketValue) *
        100
      : null;
  const marketDifferenceDetail =
    marketDifferencePercentage === null
      ? "Market comparison unavailable until the next inventory refresh"
      : marketDifferencePercentage === 0
        ? "At market for SKUs where both values are available"
        : `${Math.abs(marketDifferencePercentage).toFixed(1)}% ${marketDifferencePercentage > 0 ? "above" : "below"} market where both values are available`;

  return (
    <Box sx={{ maxWidth: 1000, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Continuous Pricing
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        The scheduler refreshes live seller inventory, claims the oldest due
        SKUs, and creates immutable price-only batches. Each SKU receives its
        next due time when scheduled, preventing pricing more often than the
        configured minimum interval.
      </Typography>

      {fetcher.data && (
        <Alert
          severity={fetcher.data.success ? "success" : "error"}
          sx={{ mb: 2 }}
        >
          {fetcher.data.success ? fetcher.data.message : fetcher.data.error}
        </Alert>
      )}

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Schedule</Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings.enabled}
                onChange={(_, enabled) =>
                  setSettings((current) => ({ ...current, enabled }))
                }
              />
            }
            label="Enable continuous pricing scheduler"
          />
          <TextField
            label="Seller key"
            value={settings.sellerKey}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                sellerKey: event.target.value,
              }))
            }
          />
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Minimum pricing interval (minutes)"
              type="number"
              value={settings.minimumIntervalMinutes}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  minimumIntervalMinutes: Number(event.target.value),
                }))
              }
              slotProps={{ htmlInput: { min: 15, max: 43200 } }}
            />
            <TextField
              label="Inventory refresh interval (minutes)"
              type="number"
              value={settings.inventoryRefreshMinutes}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  inventoryRefreshMinutes: Number(event.target.value),
                }))
              }
              slotProps={{ htmlInput: { min: 5, max: 10080 } }}
            />
            <TextField
              label="Batch size"
              type="number"
              value={settings.batchSize}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  batchSize: Number(event.target.value),
                }))
              }
              slotProps={{ htmlInput: { min: 1, max: 750 } }}
            />
          </Stack>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Button
              variant="contained"
              onClick={() => submit({ intent: "save", settings })}
              disabled={busy}
            >
              Save schedule
            </Button>
            <Button
              variant="outlined"
              onClick={() => submit({ intent: "refresh" })}
              disabled={busy || !settings.sellerKey}
            >
              Refresh inventory now
            </Button>
            <Button
              variant="outlined"
              color="secondary"
              onClick={() => submit({ intent: "run" })}
              disabled={busy || !settings.enabled}
            >
              Run scheduler cycle
            </Button>
            <Button
              variant="outlined"
              color="warning"
              onClick={() => submit({ intent: "reprice_all" })}
              disabled={
                busy || !settings.enabled || status.enabledInStockCount === 0
              }
            >
              Reprice all inventory now
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: "flex-start", sm: "center" }}
          >
            <Box>
              <Typography variant="h6">Current inventory snapshot</Typography>
              <Typography variant="body2" color="text.secondary">
                Based on the most recently refreshed seller inventory, not
                real-time availability.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                label={`${status.enabledInStockCount} enabled`}
              />
              <Chip
                size="small"
                color={status.dueCount > 0 ? "warning" : "default"}
                label={`${status.dueCount} due`}
              />
              <Chip size="small" label={`${status.inventoryCount} tracked`} />
            </Stack>
          </Stack>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "1fr",
                sm: "repeat(2, minmax(0, 1fr))",
                lg: "repeat(3, minmax(0, 1fr))",
              },
              gap: 2,
            }}
          >
            <InventoryMetric
              label="Available units"
              value={status.availableUnitCount.toLocaleString()}
              detail={`Across ${status.inStockSkuCount.toLocaleString()} in-stock SKUs`}
            />
            <InventoryMetric
              label="Current listed value"
              value={currencyFormatter.format(status.currentInventoryValue)}
              detail={marketDifferenceDetail}
              detailColor={
                marketDifferencePercentage === null
                  ? "text.secondary"
                  : marketDifferencePercentage >= 0
                    ? "success.main"
                    : "error.main"
              }
            />
            <InventoryMetric
              label="Pricing coverage"
              value={formatCoverage(
                status.pricedInStockSkuCount,
                status.inStockSkuCount,
              )}
              detail={`${status.pricedInStockSkuCount.toLocaleString()} of ${status.inStockSkuCount.toLocaleString()} in-stock SKUs priced`}
            />
            <InventoryMetric
              label="Priced awaiting publication"
              value={status.pricedAwaitingPublicationCount.toLocaleString()}
              detail={`${status.pricedAwaitingPublicationUnitCount.toLocaleString()} new inventory units without confirmed publication`}
            />
            <InventoryMetric
              label="Needs review"
              value={status.needsReviewCount.toLocaleString()}
              detail="Tracked SKUs with a review warning"
            />
            <InventoryMetric
              label="Current market value"
              value={currencyFormatter.format(status.currentMarketValue)}
              detail={`Available quantity × market price across ${status.marketValueSkuCount.toLocaleString()} in-stock SKUs`}
            />
          </Box>

          <Typography color="text.secondary">
            Last refresh:{" "}
            {status.lastRefreshAt
              ? new Date(status.lastRefreshAt).toLocaleString()
              : "never"}{" "}
            ({status.lastRefreshStatus ?? "not started"})
          </Typography>
          {status.lastRefreshError && (
            <Alert severity="error">{status.lastRefreshError}</Alert>
          )}
        </Stack>
      </Paper>

      <Paper elevation={3} sx={{ p: 3, mb: 2 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Inventory controls</Typography>
          <Typography variant="body2" color="text.secondary">
            Search and manage one bounded page at a time. Filters are retained
            in the URL so a review view can be bookmarked.
          </Typography>
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <TextField
              fullWidth
              label="Search SKU, product, set, condition, or product line"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setInventoryParams(search, inventoryState, 1);
                }
              }}
            />
            <FormControl sx={{ minWidth: 190 }}>
              <InputLabel id="inventory-state-label">State</InputLabel>
              <Select
                labelId="inventory-state-label"
                label="State"
                value={inventoryState}
                onChange={(event) =>
                  setInventoryState(
                    event.target.value as ContinuousPricingInventoryState,
                  )
                }
              >
                <MenuItem value="all">All inventory</MenuItem>
                <MenuItem value="enabled">Enabled</MenuItem>
                <MenuItem value="paused">Paused</MenuItem>
                <MenuItem value="needs_review">Needs review</MenuItem>
                <MenuItem value="in_stock">In stock</MenuItem>
                <MenuItem value="out_of_stock">Out of stock</MenuItem>
                <MenuItem value="due">Due now</MenuItem>
              </Select>
            </FormControl>
            <Button
              variant="contained"
              onClick={() => setInventoryParams(search, inventoryState, 1)}
            >
              Apply
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setSearch("");
                setInventoryState("all");
                setInventoryParams("", "all", 1);
              }}
            >
              Clear
            </Button>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Showing {firstVisible}-{lastVisible} of {inventory.total}
          </Typography>
        </Stack>
      </Paper>

      <Stack spacing={1}>
        {inventory.items.length === 0 && (
          <Alert severity="info">No inventory matches these filters.</Alert>
        )}
        {inventory.items.map((item) => (
          <Paper
            key={`${item.sellerKey}:${item.sku}`}
            variant="outlined"
            sx={{ p: 2 }}
          >
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              spacing={1}
            >
              <Box>
                <Typography variant="subtitle2">{item.productName}</Typography>
                <Typography variant="caption" color="text.secondary">
                  SKU {item.sku} · {item.productLine} · {item.setName} ·{" "}
                  {item.condition} · Qty {item.quantity} · Price{" "}
                  {item.currentPrice === null
                    ? "unknown"
                    : `$${item.currentPrice.toFixed(2)}`}
                </Typography>
                <Typography
                  variant="caption"
                  display="block"
                  color="text.secondary"
                >
                  Next: {new Date(item.nextPriceAt).toLocaleString()} · Last
                  priced:{" "}
                  {item.lastPricedAt
                    ? new Date(item.lastPricedAt).toLocaleString()
                    : "never"}{" "}
                  · Last published:{" "}
                  {item.lastPublishedAt
                    ? new Date(item.lastPublishedAt).toLocaleString()
                    : "never"}
                </Typography>
              </Box>
              <FormControlLabel
                control={
                  <Switch
                    checked={item.enabled && !item.pauseReason}
                    onChange={(_, enabled) =>
                      submit({
                        intent: "set_enabled",
                        sku: item.sku,
                        enabled,
                      })
                    }
                    disabled={busy || !item.pricingEligible}
                  />
                }
                label={
                  !item.pricingEligible
                    ? "Excluded by product-line config"
                    : item.pauseReason
                      ? "Needs review"
                      : item.enabled
                        ? "Enabled"
                        : "Paused"
                }
              />
            </Stack>
            {item.pauseReason && (
              <Alert
                severity="warning"
                sx={{ mt: 1 }}
                action={
                  <Button
                    color="inherit"
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      submit({
                        intent: "set_enabled",
                        sku: item.sku,
                        enabled: true,
                      })
                    }
                  >
                    Resume
                  </Button>
                }
              >
                {item.pauseReason}
              </Alert>
            )}
          </Paper>
        ))}
      </Stack>

      {pageCount > 1 && (
        <Stack alignItems="center" sx={{ my: 3 }}>
          <Pagination
            count={pageCount}
            page={Math.min(inventory.page, pageCount)}
            onChange={(_, page) =>
              setInventoryParams(
                loaderData.filters.search,
                loaderData.filters.state,
                page,
              )
            }
            color="primary"
          />
        </Stack>
      )}

      <Paper elevation={3} sx={{ p: 3, mt: 3 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6">Recent automatic runs</Typography>
            <Typography variant="body2" color="text.secondary">
              The newest {RECENT_AUTOMATIC_BATCH_LIMIT} continuous batches are
              shown here. Manual batch history stays in Batch Pricer.
            </Typography>
          </Box>
          {recentBatches.length === 0 ? (
            <Alert severity="info">No automatic pricing runs yet.</Alert>
          ) : (
            recentBatches.map((batch) => (
              <Stack
                key={batch.batchNumber}
                direction={{ xs: "column", sm: "row" }}
                justifyContent="space-between"
                spacing={1}
                sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}
              >
                <Typography variant="body2">
                  Batch {batch.batchNumber} · {batch.itemCount} SKUs ·{" "}
                  {new Date(batch.createdAt).toLocaleString()}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Chip size="small" label={batch.status} />
                  {batch.latestJob && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        batch.latestJob.priority > 0
                          ? "New / retry priority"
                          : "Routine"
                      }
                    />
                  )}
                </Stack>
              </Stack>
            ))
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
