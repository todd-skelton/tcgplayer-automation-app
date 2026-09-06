import { useEffect, useRef, useState } from "react";
import { Alert, Button, Stack, Typography } from "@mui/material";
import type {
  publicationHistory,
  publicationEvents,
  StoredPublication,
} from "../publication/slabPublicationStore.server";
import { slabRequest, useSlabAction, words, type Json } from "./slabClient";
export function SlabPublicationDryRun({
  previewId,
  disabled,
}: {
  previewId: string;
  disabled: boolean;
}) {
  const [history, setHistory] = useState<
    Json<Awaited<ReturnType<typeof publicationHistory>>>
  >([]);
  const [events, setEvents] = useState<
    Json<Awaited<ReturnType<typeof publicationEvents>>>
  >([]);
  const [error, setError] = useState<string | null>(null),
    [reload, setReload] = useState(0);
  const requestId = useRef<string | null>(null),
    action = useSlabAction();
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void slabRequest<{
      publications: Awaited<ReturnType<typeof publicationHistory>>;
    }>(
      `/api/slab-publications?previewId=${previewId}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setHistory(data.publications);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Unable to load dry-run history.",
          );
      });
    return () => controller.abort();
  }, [previewId, reload]);
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle1">Publication dry run</Typography>
      <Typography variant="body2">
        Check the saved plan against imported inventory and record the outcome.
        This does not contact eBay or change a price.
      </Typography>
      <Stack direction="row" gap={1}>
        <Button
          disabled={disabled || action.busy}
          onClick={() =>
            void action.run(async () => {
              requestId.current ??= crypto.randomUUID();
              const result = await slabRequest<StoredPublication>(
                "/api/slab-publications",
                { intent: "dry-run", intentId: requestId.current, previewId },
              );
              requestId.current = null;
              setReload((v) => v + 1);
              const details = await slabRequest<{
                events: Awaited<ReturnType<typeof publicationEvents>>;
              }>(`/api/slab-publications?id=${result.id}`);
              setEvents(details.events);
            })
          }
        >
          Run without writing
        </Button>
        <Button disabled={action.busy} onClick={() => setReload((v) => v + 1)}>
          Reload outcomes
        </Button>
      </Stack>
      {(action.error || error) && (
        <Alert severity="error">{action.error ?? error}</Alert>
      )}
      {history.slice(0, 5).map((row) => (
        <Stack key={row.id} direction="row" gap={1} alignItems="center">
          <Typography variant="body2">
            {words(row.mode)} ·{" "}
            {row.state === "dry-run"
              ? "completed without writing"
              : words(row.state)}{" "}
            · {new Date(row.createdAt).toLocaleString()}
            {row.reason ? ` · ${words(row.reason)}` : ""}
          </Typography>
          <Button
            size="small"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const details = await slabRequest<{
                  events: Awaited<ReturnType<typeof publicationEvents>>;
                }>(`/api/slab-publications?id=${row.id}`);
                setEvents(details.events);
              })
            }
          >
            Show steps
          </Button>
          {row.mode === "dry-run" &&
            ["approved", "checking"].includes(row.state) && (
              <Button
                size="small"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await slabRequest("/api/slab-publications", {
                      intent: "dry-run",
                      intentId: row.id,
                      previewId,
                    });
                    setReload((v) => v + 1);
                  })
                }
              >
                Resume dry run
              </Button>
            )}
        </Stack>
      ))}
      {events.length > 0 && (
        <details open>
          <summary>Recorded execution steps (latest first)</summary>
          {events.map((event) => (
            <Typography key={event.sequence} variant="body2">
              {words(event.state)} ·{" "}
              {new Date(event.createdAt).toLocaleString()}
              {event.reason ? ` · ${words(event.reason)}` : ""}
            </Typography>
          ))}
        </details>
      )}
    </Stack>
  );
}
