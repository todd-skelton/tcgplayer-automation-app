import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { ClientOnlyDataGrid } from "~/features/file-upload/components/ClientOnlyDataGrid";
import type {
  getEvidenceRevision,
  EvidenceStatus,
} from "../evidence/evidenceRefreshStore.server";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { SaleEvidence } from "../evidence/slabEvidence";
import {
  screenComparableSale,
  type CompDecision,
} from "../screening/screenComparables";
import {
  amount,
  optionalNumber,
  slabRequest,
  useSlabAction,
  words,
  type Json,
} from "./slabClient";

type EvidencePage = Json<
  NonNullable<Awaited<ReturnType<typeof getEvidenceRevision>>>
> & { page?: { offset: number; total: number; nextOffset: number | null } };
type CompRow = {
  id: string;
  sale: SaleEvidence;
  status: string;
  reasons: string;
  decision?: CompDecision;
};
export default function SlabCompReview({
  revisionId,
  target,
  canReview,
  onChanged,
  onAdditional,
}: {
  revisionId: string;
  target: Json<StoredSlabIdentity>;
  canReview: boolean;
  onChanged: () => void;
  onAdditional: (statuses: Json<EvidenceStatus[]>) => void;
}) {
  const [page, setPage] = useState<EvidencePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [decisions, setDecisions] = useState<CompDecision[]>([]);
  const [selected, setSelected] = useState<CompRow | null>(null);
  const [decision, setDecision] = useState<"accept" | "exclude">("accept");
  const [note, setNote] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const action = useSlabAction();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      slabRequest<EvidencePage>(
        `/api/slab-evidence?revision=${revisionId}&offset=${offset}`,
        undefined,
        controller.signal,
      ),
      canReview && target.valuationGroupKey
        ? slabRequest<{ decisions: CompDecision[] }>(
            `/api/slab-comp-decisions?${new URLSearchParams({ group: target.valuationGroupKey, revisions: revisionId })}`,
            undefined,
            controller.signal,
          )
        : Promise.resolve({ decisions: [] }),
    ])
      .then(([data, reviews]) => {
        if (!controller.signal.aborted) {
          setPage(data);
          setDecisions(reviews.decisions);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revisionId, offset, target.valuationGroupKey, canReview]);
  const payload = page?.payload;
  const sales =
    payload?.kind === "alt-sale-detail"
      ? payload.data
        ? [payload.data]
        : []
      : payload?.kind === "alt-sales" || payload?.kind === "ebay-sales"
        ? (payload.data.sales ?? [])
        : [];
  const coverage =
    payload?.kind === "alt-sales" || payload?.kind === "ebay-sales"
      ? payload.data.coverage
      : null;
  const rows: CompRow[] = sales.map((sale, i) => {
    const decision = decisions.find(
      (d) =>
        d.provider === sale.provider &&
        d.providerId === sale.providerId &&
        d.date === sale.date,
    );
    const screened = screenComparableSale(
      {
        revisionId,
        fetchedAt: page!.fetchedAt,
        window: coverage?.requestedWindow ?? {
          from: sale.date ?? "",
          to: sale.date ?? "",
        },
        sale,
      },
      { ...target, updatedAt: new Date(target.updatedAt) },
      { currency: "USD", decision },
    );
    return {
      id: `${i}:${sale.providerId}`,
      sale,
      status: screened.status,
      reasons: screened.reasons.map((r) => words(r.code)).join("; "),
      decision,
    };
  });
  const columns: GridColDef<CompRow>[] = [
    {
      field: "review",
      headerName: "Details",
      width: 100,
      sortable: false,
      renderCell: ({ row }) => (
        <Button
          onClick={() => {
            setSelected(row);
            setDecision(row.decision?.decision ?? "accept");
            setNote(row.decision?.note ?? "");
            setItemPrice(row.decision?.itemPrice?.amount.toString() ?? "");
          }}
        >
          Review
        </Button>
      ),
    },
    {
      field: "date",
      headerName: "Sold date",
      width: 115,
      valueGetter: (_, row) => row.sale.date ?? "Unknown",
    },
    {
      field: "title",
      headerName: "Sale",
      flex: 1,
      minWidth: 210,
      valueGetter: (_, row) => row.sale.title ?? row.sale.providerId,
    },
    {
      field: "grade",
      headerName: "Grade",
      width: 110,
      valueGetter: (_, row) =>
        `${row.sale.grading.grader} ${row.sale.grading.label ?? row.sale.grading.encoding}`,
    },
    {
      field: "price",
      headerName: "Reported price",
      width: 160,
      valueGetter: (_, row) =>
        amount(row.sale.price?.amount, row.sale.price?.currency ?? null),
    },
    {
      field: "shipping",
      headerName: "Shipping",
      width: 140,
      valueGetter: (_, row) =>
        amount(row.sale.shipping?.amount, row.sale.shipping?.currency ?? null),
    },
    {
      field: "format",
      headerName: "Format",
      width: 145,
      valueGetter: (_, row) => row.sale.format ?? "Unknown",
    },
    {
      field: "status",
      headerName: "Comp status",
      width: 130,
      valueGetter: (value) => words(value),
    },
  ];
  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      {action.error && <Alert severity="error">{action.error}</Alert>}
      <Typography variant="body2">
        {coverage
          ? `${coverage.sourceCount} source observations · ${words(coverage.reason)}${coverage.limitPerGrade ? ` · Up to ${coverage.limitPerGrade} sales per grade` : ""}`
          : "Saved sale detail"}
        . Alt history covers all grades. Comp status is screened against the
        selected identity; the final calculation also reconciles duplicate
        events across sources.
      </Typography>
      {payload?.kind === "ebay-sales" && payload.data.status !== "sold" && (
        <Alert severity="warning">
          This response contains active listings instead of sold evidence.
        </Alert>
      )}
      {page && sales.length === 0 && (
        <Alert severity="info">
          No sold observations in this saved response.
        </Alert>
      )}
      <div style={{ height: 430 }}>
        <ClientOnlyDataGrid
          rows={rows}
          columns={columns}
          loading={loading}
          hideFooter
          disableRowSelectionOnClick
        />
      </div>
      <Stack direction="row" gap={2}>
        <Button
          disabled={loading || action.busy || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous 50
        </Button>
        <Typography sx={{ alignSelf: "center" }}>
          {page?.page
            ? `${offset + (sales.length ? 1 : 0)}–${offset + sales.length} of ${page.page.total}`
            : `${sales.length} observations`}
        </Typography>
        <Button
          disabled={loading || action.busy || page?.page?.nextOffset == null}
          onClick={() => setOffset(page!.page!.nextOffset!)}
        >
          Next 50
        </Button>
        {payload?.kind === "ebay-sales" &&
          payload.data.page?.nextOffset != null && (
            <Button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await slabRequest<{
                    statuses: EvidenceStatus[];
                  }>("/api/slab-evidence", {
                    intent: "next-page",
                    revision: revisionId,
                  });
                  onAdditional(result.statuses);
                })
              }
            >
              Fetch next source page
            </Button>
          )}
      </Stack>
      <Dialog
        open={!!selected}
        onClose={() => {
          if (!action.busy) setSelected(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Review sold evidence</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {action.error && <Alert severity="error">{action.error}</Alert>}
            <Typography>
              {selected?.sale.title ?? selected?.sale.providerId}
            </Typography>
            {selected?.sale.sourceUrl &&
              /^https:\/\//.test(selected.sale.sourceUrl) && (
                <Link
                  href={selected.sale.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open source sale
                </Link>
              )}
            <Typography variant="body2">
              {selected?.sale.provider} ·{" "}
              {selected?.sale.date ?? "Date unknown"} ·{" "}
              {selected?.sale.format ?? "Format unknown"} · Quantity{" "}
              {selected?.sale.quantity ?? "unknown"}
            </Typography>
            <Typography variant="body2">
              {selected?.reasons || "Identity and price passed screening."}
            </Typography>
            {selected?.sale.provider === "alt" &&
              payload?.kind === "alt-sales" && (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const result = await slabRequest<{
                        statuses: EvidenceStatus[];
                      }>("/api/slab-evidence", {
                        intent: "sale-detail",
                        revision: revisionId,
                        transactionId: selected.sale.providerId,
                      });
                      onAdditional(result.statuses);
                    })
                  }
                >
                  Fetch full sale details
                </Button>
              )}
            {!canReview ? (
              <Alert severity="info">
                Return to the confirmed owned grade to save comp decisions.
              </Alert>
            ) : (
              <>
                <TextField
                  select
                  label="Comp decision"
                  value={decision}
                  onChange={(e) =>
                    setDecision(e.target.value as "accept" | "exclude")
                  }
                >
                  <MenuItem value="accept">Include after review</MenuItem>
                  <MenuItem value="exclude">Exclude</MenuItem>
                </TextField>
                <TextField
                  label="Verified item price in USD (optional)"
                  type="number"
                  value={itemPrice}
                  onChange={(e) => setItemPrice(e.target.value)}
                  helperText="Use only an item amount verified from the sale. Shipping and fees remain separate."
                  inputProps={{ min: 0.01, step: 0.01 }}
                />
                <TextField
                  label="Review reason"
                  required
                  multiline
                  value={note}
                  inputProps={{ maxLength: 1000 }}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Typography variant="body2">
                  Including a comp does not override a conflicting card identity
                  or unconfirmed sale outcome.
                </Typography>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={action.busy} onClick={() => setSelected(null)}>
            Close
          </Button>
          {canReview && (
            <Button
              disabled={action.busy || !note.trim()}
              onClick={() =>
                void action.run(async () => {
                  const sale = selected!.sale;
                  const result = await slabRequest<{ decision: CompDecision }>(
                    "/api/slab-comp-decisions",
                    {
                      slabId: target.id,
                      identityRevision: target.revision,
                      revisionId,
                      provider: sale.provider,
                      providerId: sale.providerId,
                      date: sale.date,
                      decision,
                      note,
                      itemPrice: itemPrice.trim()
                        ? { amount: optionalNumber(itemPrice), currency: "USD" }
                        : null,
                    },
                  );
                  setDecisions([
                    ...decisions.filter(
                      (d) =>
                        !(
                          d.provider === sale.provider &&
                          d.providerId === sale.providerId &&
                          d.date === sale.date
                        ),
                    ),
                    result.decision,
                  ]);
                  setSelected(null);
                  onChanged();
                })
              }
            >
              Save decision
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
