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
  type ActionFunctionArgs,
  type MetaFunction,
} from "react-router";
import { inventoryPublicationSettingsRepository } from "~/core/db";
import { normalizeInventoryPublicationSettings } from "../services/inventoryPublicationSettings";
import type {
  InventoryPublicationConfiguration,
  InventoryPublicationSettings,
} from "../types/inventoryPublicationSettings";

type ActionData =
  | { success: true; configuration: InventoryPublicationConfiguration }
  | { success: false; error: string };

const SOURCE_LABELS = {
  pending_inventory: "Inventory Manager batches",
  seller: "Seller inventory batches",
  csv: "CSV batches (price-only; quantity deltas remain manual)",
  continuous: "Continuous pricing candidates",
} as const;

export const meta: MetaFunction = () => [
  { title: "Inventory Publication Configuration" },
  {
    name: "description",
    content:
      "Control automatic Seller Portal pricing and inventory publication safety.",
  },
];

export async function loader() {
  return data(await inventoryPublicationSettingsRepository.get());
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const payload = (await request.json()) as {
      intent?: unknown;
      settings?: unknown;
    };
    if (payload.intent === "resume") {
      return data<ActionData>({
        success: true,
        configuration: await inventoryPublicationSettingsRepository.resume(),
      });
    }
    if (payload.intent === "save") {
      return data<ActionData>({
        success: true,
        configuration: await inventoryPublicationSettingsRepository.save(
          normalizeInventoryPublicationSettings(payload.settings),
        ),
      });
    }
    return data<ActionData>(
      { success: false, error: "Unsupported publication settings action." },
      { status: 400 },
    );
  } catch (error) {
    return data<ActionData>(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}

export default function PublicationConfigurationRoute() {
  const initialConfiguration = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [settings, setSettings] = useState(initialConfiguration.settings);

  useEffect(() => {
    if (!fetcher.data?.success) {
      return;
    }
    setConfiguration(fetcher.data.configuration);
    setSettings(fetcher.data.configuration.settings);
  }, [fetcher.data]);

  const updatePolicy = <
    Key extends keyof InventoryPublicationSettings["policy"],
  >(
    key: Key,
    value: InventoryPublicationSettings["policy"][Key],
  ) => {
    setSettings((current) => ({
      ...current,
      policy: { ...current.policy, [key]: value },
    }));
  };

  const submit = (intent: "save" | "resume") => {
    fetcher.submit(intent === "save" ? { intent, settings } : { intent }, {
      method: "post",
      encType: "application/json",
    });
  };

  const runtime = configuration.runtime;
  const isSaving = fetcher.state !== "idle";

  return (
    <Box sx={{ maxWidth: 900, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Inventory Publication
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Automatic publication uses durable staged imports. It is disabled by
        default, never automatically replays ambiguous outcomes, and keeps
        quantity deltas separate from continuous price-only work.
      </Typography>

      {fetcher.data && !fetcher.data.success && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {fetcher.data.error}
        </Alert>
      )}

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Runtime safety</Typography>
          <Alert
            severity={
              runtime.authenticationStatus === "invalid" || runtime.circuitOpen
                ? "error"
                : runtime.authenticationStatus === "healthy"
                  ? "success"
                  : "info"
            }
          >
            Authentication: {runtime.authenticationStatus}. Circuit:{" "}
            {runtime.circuitOpen ? "paused" : "ready"}. Consecutive failures:{" "}
            {runtime.consecutiveFailures}.
            {runtime.pauseReason ? ` ${runtime.pauseReason}` : ""}
          </Alert>
          <FormControlLabel
            control={
              <Switch
                checked={settings.globalPaused}
                onChange={(_, checked) =>
                  setSettings((current) => ({
                    ...current,
                    globalPaused: checked,
                  }))
                }
              />
            }
            label="Global publication pause"
          />
          {(runtime.circuitOpen ||
            runtime.authenticationStatus === "invalid") && (
            <Button
              variant="outlined"
              color="warning"
              onClick={() => submit("resume")}
              disabled={isSaving}
            >
              Resume after authentication is refreshed
            </Button>
          )}
        </Stack>
      </Paper>

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Automatic publication</Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings.policy.automaticPublishingEnabled}
                onChange={(_, checked) =>
                  updatePolicy("automaticPublishingEnabled", checked)
                }
              />
            }
            label="Enable automatic publication globally"
          />

          {Object.entries(SOURCE_LABELS).map(([sourceType, label]) => (
            <FormControlLabel
              key={sourceType}
              control={
                <Switch
                  checked={
                    settings.policy.automaticSources[
                      sourceType as keyof typeof SOURCE_LABELS
                    ]
                  }
                  onChange={(_, checked) =>
                    updatePolicy("automaticSources", {
                      ...settings.policy.automaticSources,
                      [sourceType]: checked,
                    })
                  }
                />
              }
              label={label}
            />
          ))}
        </Stack>
      </Paper>

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Guardrails</Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Failure limit"
              type="number"
              value={settings.consecutiveFailureLimit}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  consecutiveFailureLimit: Number(event.target.value),
                }))
              }
              slotProps={{ htmlInput: { min: 1, max: 100 } }}
            />
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Minimum price change ($)"
              type="number"
              value={settings.policy.minimumAbsolutePriceChange}
              onChange={(event) =>
                updatePolicy(
                  "minimumAbsolutePriceChange",
                  Number(event.target.value),
                )
              }
              slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
            />
            <TextField
              label="Candidate maximum age (minutes)"
              type="number"
              value={Math.round(settings.policy.maximumCandidateAgeMs / 60_000)}
              onChange={(event) =>
                updatePolicy(
                  "maximumCandidateAgeMs",
                  Number(event.target.value) * 60_000,
                )
              }
              slotProps={{ htmlInput: { min: 1, max: 10080 } }}
            />
            <TextField
              label="Staged micro-batch maximum"
              type="number"
              value={settings.policy.stagedMicroBatchMaximum}
              onChange={(event) =>
                updatePolicy(
                  "stagedMicroBatchMaximum",
                  Number(event.target.value),
                )
              }
              slotProps={{ htmlInput: { min: 1, max: 750 } }}
            />
          </Stack>
          <FormControlLabel
            control={
              <Switch
                checked={settings.policy.allowWarnings}
                onChange={(_, checked) =>
                  updatePolicy("allowWarnings", checked)
                }
              />
            }
            label="Allow pricing warnings to publish automatically"
          />
        </Stack>
      </Paper>

      <Alert severity="warning" sx={{ mb: 2 }}>
        Quantity values are additive in staged imports. CSV quantity deltas are
        always excluded from automatic publication. Once an inventory delta is
        planned, it cannot be recreated under another pricing candidate.
      </Alert>

      <Button
        variant="contained"
        onClick={() => submit("save")}
        disabled={isSaving}
      >
        Save publication settings
      </Button>
    </Box>
  );
}
