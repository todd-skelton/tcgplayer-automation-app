import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { ClientOnlyDataGrid } from "~/features/file-upload/components/ClientOnlyDataGrid";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { EvidenceWindow } from "../evidence/slabEvidence";
import type { SlabSupplyContext } from "../supply/slabSupply.server";
import {
  amount,
  slabRequest,
  useSlabAction,
  words,
  type Json,
} from "./slabClient";
type Row = NonNullable<SlabSupplyContext["context"]>["rows"][number];
const columns: GridColDef<Row>[] = [
  {
    field: "title",
    headerName: "Active listing",
    minWidth: 260,
    flex: 1,
    valueGetter: (_, row) => row.listing.title ?? row.listing.providerId,
    renderCell: ({ row }) =>
      row.listing.sourceUrl && /^https:\/\//.test(row.listing.sourceUrl) ? (
        <Link href={row.listing.sourceUrl} target="_blank" rel="noreferrer">
          {row.listing.title ?? row.listing.providerId}
        </Link>
      ) : (
        (row.listing.title ?? row.listing.providerId)
      ),
  },
  {
    field: "item",
    headerName: "Item ask / bid",
    width: 155,
    valueGetter: (_, row) =>
      `${amount(row.listing.price?.amount, row.listing.price?.currency ?? null)} (${row.listing.priceKind})`,
  },
  {
    field: "shipping",
    headerName: "Shipping",
    width: 130,
    valueGetter: (_, row) =>
      amount(
        row.listing.shipping?.amount,
        row.listing.shipping?.currency ?? null,
      ),
  },
  {
    field: "deliveredAsk",
    headerName: "Delivered (USD)",
    width: 150,
    valueGetter: (value) => amount(value),
  },
  {
    field: "listingAgeDays",
    headerName: "Listing age",
    width: 110,
    valueGetter: (value) =>
      value === null
        ? "Unknown"
        : value < 1
          ? "<1 day"
          : `${Math.floor(value)} days`,
  },
  {
    field: "status",
    headerName: "Comparison",
    width: 140,
    valueGetter: (value) => words(value),
  },
  {
    field: "reasons",
    headerName: "Review reasons",
    minWidth: 220,
    flex: 1,
    valueGetter: (_, row) => row.reasons.map(words).join("; "),
  },
];
export default function SlabSupplyPanel({
  record,
  grade,
  window,
  seller,
}: {
  record: Json<StoredSlabIdentity>;
  grade: string;
  window: EvidenceWindow;
  seller: string;
}) {
  const [result, setResult] = useState<Json<SlabSupplyContext> | null>(null);
  const [key, setKey] = useState("");
  const [offset, setOffset] = useState(0);
  const [sourceHistory, setSourceHistory] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = useSlabAction();
  const params = new URLSearchParams({
    slabId: record.id,
    grade,
    ...window,
    seller,
    offset: String(offset),
    ...(key ? { key } : {}),
  }).toString();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);
    const read = async () => {
      try {
        const data = await slabRequest<SlabSupplyContext>(
          `/api/slab-supply?${params}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult(data);
        if (data.page && data.page.offset !== offset)
          setOffset(data.page.offset);
        if (
          data.statuses.some(
            (s) => s.state === "queued" || s.state === "running",
          )
        )
          timer = setTimeout(read, 2000);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Supply is unavailable.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [params, reload]);

  const identityChanged = result && result.identityRevision !== record.revision;
  const context = identityChanged ? null : result?.context;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Supply context</Typography>
        <Typography variant="body2">
          Asking prices describe unsold listings. They do not change the
          recommendation or establish a price floor or ceiling.
        </Typography>
        <Stack direction="row" gap={2} useFlexGap flexWrap="wrap">
          <Button
            variant="outlined"
            disabled={action.busy || loading}
            onClick={() =>
              void action.run(async () => {
                await slabRequest("/api/slab-supply", {
                  intent: "refresh",
                  slabId: record.id,
                  identityRevision: record.revision,
                  grade,
                  window,
                  seller,
                });
                setKey("");
                setOffset(0);
                setSourceHistory([]);
                setReload((v) => v + 1);
              })
            }
          >
            Refresh supply
          </Button>
          <Button
            disabled={action.busy || loading}
            onClick={() => setReload((v) => v + 1)}
          >
            Reload saved supply
          </Button>
          {result && result.statuses.length > 0 && (
            <TextField
              size="small"
              select
              label="Supply source"
              value={result.selectedKey ?? ""}
              disabled={action.busy || loading}
              onChange={(e) => {
                setKey(e.target.value);
                setOffset(0);
                setSourceHistory([]);
              }}
            >
              {result.statuses.map((s) => (
                <MenuItem key={s.key} value={s.key}>
                  {s.spec.kind === "alt-supply"
                    ? "Alt"
                    : `eBay page ${s.spec.kind === "ebay-supply" ? s.spec.offset / s.spec.limit + 1 : 1}`}{" "}
                  · {words(s.state)}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Stack>
        {loading && (
          <Typography role="status">Loading saved supply…</Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {identityChanged && (
          <Alert severity="warning">
            The identity changed. Reopen the certificate before using this
            supply context.
          </Alert>
        )}
        {action.error && <Alert severity="error">{action.error}</Alert>}
        {result?.statuses.map((s) => (
          <Stack key={s.key} direction="row" gap={1} alignItems="center">
            <Typography variant="body2">
              {words(s.spec.kind)}: {words(s.state)}
              {s.errorCode ? ` · ${words(s.errorCode)}` : ""}
            </Typography>
            {(s.state === "queued" || s.state === "running") && (
              <Button
                size="small"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await slabRequest("/api/slab-evidence", {
                      intent: "cancel",
                      key: s.key,
                      runId: s.runId,
                    });
                    setReload((v) => v + 1);
                  })
                }
              >
                Cancel supply refresh
              </Button>
            )}
          </Stack>
        ))}
        {result && (
          <Typography variant="body2">
            Excludes {result.knownOwnListings} known item IDs imported for{" "}
            {seller}. Import missing inventory before treating potential matches
            as competitors.
          </Typography>
        )}
        {!loading && !context && !identityChanged && (
          <Alert severity="info">
            No saved active-supply response. Refresh to request one.
          </Alert>
        )}
        {context && (
          <>
            {context.stale && (
              <Alert severity="warning">
                This supply snapshot is stale or its latest refresh failed. Old
                asks remain visible but are excluded from competition counts.
              </Alert>
            )}
            <Typography>
              {context.equivalentListings} equivalent listings ·{" "}
              {context.potentialListings} potential matches ·{" "}
              {context.excludedListings} excluded
            </Typography>
            <Typography variant="body2">
              Lowest equivalent delivered ask:{" "}
              {amount(context.lowestEquivalentDeliveredAsk)} · Lowest potential
              delivered ask: {amount(context.lowestPotentialDeliveredAsk)}
            </Typography>
            <Typography variant="body2">
              Observed {new Date(context.capturedAt).toLocaleString()} ·{" "}
              {context.reportedCount} listings in this response ·{" "}
              {result?.sourceHasMorePages
                ? "More source pages exist; this is a partial page."
                : "Search coverage is incomplete."}
            </Typography>
            <div style={{ height: 370 }}>
              <ClientOnlyDataGrid
                rows={context.rows}
                getRowId={(row: Row) => row.key}
                columns={columns}
                hideFooter
                loading={loading}
                disableRowSelectionOnClick
              />
            </div>
            <Stack direction="row" gap={2}>
              {sourceHistory.length > 0 && (
                <Button
                  disabled={loading || action.busy}
                  onClick={() => {
                    setKey(sourceHistory.at(-1)!);
                    setSourceHistory(sourceHistory.slice(0, -1));
                    setOffset(0);
                  }}
                >
                  Previous source page
                </Button>
              )}
              {result?.sourceHasMorePages && (
                <Button
                  disabled={loading || action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const revision = result.statuses.find(
                        (s) => s.key === result.selectedKey,
                      )?.latestRevision;
                      const next = await slabRequest<{
                        statuses: Array<{ key: string }>;
                      }>("/api/slab-evidence", {
                        intent: "next-page",
                        revision,
                      });
                      if (next.statuses[0]) {
                        setSourceHistory([
                          ...sourceHistory,
                          result.selectedKey!,
                        ]);
                        setKey(next.statuses[0].key);
                        setOffset(0);
                      }
                    })
                  }
                >
                  Fetch next source page
                </Button>
              )}
              <Button
                disabled={loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous supply rows
              </Button>
              <Typography sx={{ alignSelf: "center" }}>
                {offset + Math.min(1, context.rows.length)}–
                {offset + context.rows.length} of {result?.page?.total}
              </Typography>
              <Button
                disabled={loading || result?.page?.nextOffset == null}
                onClick={() => setOffset(result!.page!.nextOffset!)}
              >
                Next supply rows
              </Button>
            </Stack>
            <Typography variant="body2">
              Listing age is not time at the current price. Seller identity and
              available quantity remain unknown when the source omits them.
            </Typography>
            {result?.changes ? (
              <>
                <Typography variant="body2">
                  Observed from{" "}
                  {new Date(result.changes.observedFrom).toLocaleString()}{" "}
                  through{" "}
                  {new Date(result.changes.observedThrough).toLocaleString()}:{" "}
                  {result.changes.changes.length} changes. Continuous exposure
                  between observations is unknown.
                </Typography>
                {result.changes.changes.slice(0, 20).map((change, i) => (
                  <Typography key={`${change.key}:${i}`} variant="body2">
                    {change.key}: {words(change.kind)}. No sale inferred.
                  </Typography>
                ))}
              </>
            ) : (
              <Typography variant="body2">
                One recorded observation cannot establish exposure or sale rate.
              </Typography>
            )}
          </>
        )}
        <Alert severity="info">
          Seller order outcomes are not connected. Sale probability and time to
          sell remain unavailable; listing disappearance is not a sale.
        </Alert>
      </Stack>
    </Paper>
  );
}
