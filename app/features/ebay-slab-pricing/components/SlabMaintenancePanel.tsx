import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { MaintenanceSettings } from "../maintenance/slabMaintenance";
import type { MaintenanceView } from "../routes/api.slab-maintenance.server";
import { slabRequest, useSlabAction, words, type Json } from "./slabClient";
export default function SlabMaintenancePanel({ seller }: { seller: string }) {
  const [view, setView] = useState<Json<MaintenanceView> | null>(null),
    [draft, setDraft] = useState<MaintenanceSettings | null>(null),
    [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null),
    action = useSlabAction();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const data = await slabRequest<MaintenanceView>(
          `/api/slab-maintenance?${new URLSearchParams({ seller })}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setView(data);
        setDraft((previous) => previous ?? data.settings);
        setError(null);
        if (data.settings.enabled) timer = setTimeout(read, 5000);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Maintenance status unavailable.",
          );
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [seller, reload]);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Evidence maintenance · {seller}</Typography>
        <Typography variant="body2">
          Refresh confirmed inventory in small groups and update recommendations
          from fresh saved evidence. Reviewed price overrides stay in manual
          review. This never publishes prices.
        </Typography>
        {(error || action.error) && (
          <Alert severity="error">{error ?? action.error}</Alert>
        )}
        {draft && (
          <>
            <Stack direction="row" gap={2} useFlexGap flexWrap="wrap">
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.enabled}
                    onChange={(e) =>
                      setDraft({ ...draft, enabled: e.target.checked })
                    }
                  />
                }
                label="Enable maintenance"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={draft.includeSupply}
                    onChange={(e) =>
                      setDraft({ ...draft, includeSupply: e.target.checked })
                    }
                  />
                }
                label="Include active supply"
              />
              {(
                [
                  ["intervalMinutes", "Refresh interval (minutes)"],
                  ["batchSize", "Listings per cycle"],
                  ["refreshBudget", "Refresh jobs per cycle"],
                ] as const
              ).map(([field, label]) => (
                <TextField
                  key={field}
                  size="small"
                  type="number"
                  label={label}
                  value={draft[field]}
                  onChange={(e) =>
                    setDraft({ ...draft, [field]: Number(e.target.value) })
                  }
                />
              ))}
            </Stack>
            <Stack direction="row" gap={1}>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await slabRequest<{
                      settings: MaintenanceSettings;
                    }>("/api/slab-maintenance", {
                      intent: "save",
                      settings: draft,
                    });
                    setDraft(result.settings);
                    setReload((v) => v + 1);
                  })
                }
              >
                Save maintenance settings
              </Button>
              <Button
                disabled={action.busy}
                onClick={() => setReload((v) => v + 1)}
              >
                Reload status
              </Button>
              <Button
                disabled={action.busy || !view}
                onClick={() => setDraft(view!.settings)}
              >
                Reset edits
              </Button>
            </Stack>
            {view && draft.revision !== view.settings.revision && (
              <Alert severity="warning">
                Settings changed elsewhere. Reset edits before saving.
              </Alert>
            )}
          </>
        )}
        {view && (
          <>
            <Typography>
              {view.settings.enabled ? "Enabled" : "Paused"} · Last cycle:{" "}
              {view.settings.lastCycleAt
                ? new Date(view.settings.lastCycleAt).toLocaleString()
                : "Not run"}
            </Typography>
            <Typography variant="body2">
              Next worker check:{" "}
              {view.settings.enabled && view.settings.nextCycleAt
                ? new Date(view.settings.nextCycleAt).toLocaleString()
                : "Paused"}
              . Turning maintenance off stops further work; already requested
              evidence and an in-progress calculation may finish.
            </Typography>
            {view.workerMode === "external" && (
              <Alert severity="info">
                Maintenance requires the existing slab evidence worker to be
                running.
              </Alert>
            )}
            {view.settings.lastError && (
              <Alert severity="warning">{words(view.settings.lastError)}</Alert>
            )}
            {view.settings.lastSummary && (
              <Typography variant="body2">
                Last cycle: {view.settings.lastSummary.checked} listings checked
                · {view.settings.lastSummary.queued} queued source jobs ·{" "}
                {view.settings.lastSummary.recalculated} recalculated ·{" "}
                {view.settings.lastSummary.held} held for review.
              </Typography>
            )}
            <Typography variant="body2">
              Connections:{" "}
              {view.providers
                .map((p) => `${p.provider}: ${words(p.status)}`)
                .join(" · ")}
              . <Link href="/slab-connections">Manage connections</Link>
            </Typography>
            <Alert severity="info">
              Automatic publication is unavailable. Live seller access and
              adopted automation cohorts are required.
            </Alert>
            <details>
              <summary>Recent listing checks</summary>
              {view.items.map((item) => (
                <Typography key={item.id} variant="body2">
                  {item.title}: {words(item.outcome)} · {words(item.reason)}
                </Typography>
              ))}
              {view.items.length === 0 && (
                <Typography variant="body2">No listing checks yet.</Typography>
              )}
            </details>
          </>
        )}
      </Stack>
    </Paper>
  );
}
