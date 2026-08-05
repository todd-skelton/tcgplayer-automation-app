import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Paper,
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
  type ActionFunctionArgs,
  type MetaFunction,
} from "react-router";
import {
  continuousPricingRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { refreshContinuousPricingInventory } from "../services/continuousInventoryRefresh.server";
import { runContinuousPricingSchedulerCycle } from "../services/continuousPricingScheduler.server";
import { normalizeContinuousPricingSettings } from "../services/continuousPricingSettings";
import type { ContinuousPricingSettings } from "../types/continuousPricing";

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

export async function loader() {
  const configuration = await inventoryPublicationSettingsRepository.get();
  const settings = configuration.settings.continuousPricing;
  const [status, inventory] = settings.sellerKey
    ? await Promise.all([
        continuousPricingRepository.getStatus(settings.sellerKey, settings),
        continuousPricingRepository.findAll(settings.sellerKey),
      ])
    : [
        {
          settings,
          inventoryCount: 0,
          enabledInStockCount: 0,
          dueCount: 0,
          oldestDueAt: null,
          lastRefreshAt: null,
          lastRefreshStatus: null,
          lastRefreshError: null,
        },
        [],
      ];

  return data({ status, inventory });
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
      const count = await refreshContinuousPricingInventory(current.sellerKey);
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
  const [settings, setSettings] = useState<ContinuousPricingSettings>(
    loaderData.status.settings,
  );

  useEffect(() => {
    setSettings(loaderData.status.settings);
  }, [loaderData.status.settings]);

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
  const { status, inventory } = loaderData;

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
          </Stack>
        </Stack>
      </Paper>

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stack spacing={1}>
          <Typography variant="h6">Status</Typography>
          <Typography>
            {status.enabledInStockCount} enabled and in stock ·{" "}
            {status.dueCount} due · {status.inventoryCount} tracked
          </Typography>
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

      <Stack spacing={1}>
        {inventory.map((item) => (
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
                  SKU {item.sku} · {item.setName} · {item.condition} · Qty{" "}
                  {item.quantity} · Price{" "}
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
                    disabled={busy}
                  />
                }
                label={
                  item.pauseReason
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
    </Box>
  );
}
