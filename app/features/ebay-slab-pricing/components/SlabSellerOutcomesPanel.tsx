import { useState } from "react";
import {
  Alert,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SellerOutcomeReview } from "../supply/sellerOutcomes.server";
import {
  slabRequest,
  useSlabAction,
  words,
  amount,
  type Json,
} from "./slabClient";
export default function SlabSellerOutcomesPanel({
  seller,
}: {
  seller: string;
}) {
  const [itemId, setItemId] = useState(""),
    [csv, setCsv] = useState("");
  const [review, setReview] = useState<Json<SellerOutcomeReview> | null>(null),
    [message, setMessage] = useState("");
  const action = useSlabAction();
  const load = async (id: string) =>
    setReview(
      await slabRequest<SellerOutcomeReview>(
        `/api/slab-outcomes?${new URLSearchParams({ seller, itemId: id })}`,
      ),
    );
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Seller outcomes · {seller}</Typography>
        <Typography variant="body2">
          Record reviewed sales, cancellations and relists for imported
          listings. Observations keep their first recorded time and source;
          repeated imports do not duplicate them. Conflicting claims remain
          unresolved. Inventory and prices are unchanged.
        </Typography>
        {action.error && <Alert severity="error">{action.error}</Alert>}
        {message && <Alert severity="success">{message}</Alert>}
        <Stack direction="row" gap={1}>
          <TextField
            size="small"
            label="Outcome listing item ID"
            value={itemId}
            onChange={(event) => setItemId(event.target.value)}
          />
          <Button
            disabled={action.busy || !itemId.trim()}
            onClick={() => void action.run(() => load(itemId.trim()))}
          >
            Read saved outcomes
          </Button>
        </Stack>
        <details>
          <summary>Import reviewed outcomes</summary>
          <Stack spacing={2} sx={{ mt: 2 }}>
            <Typography variant="body2">
              Paste up to 50 rows. Required columns: event_id, item_id, kind,
              occurred_at, quantity, note. Use sale, cancellation or relist;
              quantity must be 1. Use a UTC time such as 2026-09-01T12:00:00Z.
              Optional sale columns: price, currency (item price only).
              Cancellations require related_sale_id; relists require
              next_item_id. Use a stable event ID and a note describing the
              evidence. Import each original listing into this seller's
              inventory first.
            </Typography>
            <TextField
              label="Seller outcome CSV"
              multiline
              minRows={3}
              maxRows={8}
              value={csv}
              onChange={(event) => setCsv(event.target.value)}
            />
            <Button
              disabled={action.busy || !csv.trim()}
              onClick={() =>
                void action.run(async () => {
                  const result = await slabRequest<{
                    inserted: number;
                    supplied: number;
                    itemIds: string[];
                  }>("/api/slab-outcomes", {
                    intent: "import-csv",
                    seller,
                    csv,
                  });
                  setMessage(
                    `${result.inserted} new observations saved from ${result.supplied} rows.`,
                  );
                  setCsv("");
                  setItemId(result.itemIds[0]);
                  await load(result.itemIds[0]);
                })
              }
            >
              Save reviewed outcomes
            </Button>
          </Stack>
        </details>
        {review && (
          <>
            <Typography>
              Listing {review.itemId}: {review.summary.sales} uncancelled sale
              records · {review.summary.cancellations} cancellation records ·{" "}
              {review.summary.relists} relist records.
            </Typography>
            {review.summary.unresolved.length > 0 && (
              <Alert severity="warning">
                Unresolved event IDs: {review.summary.unresolved.join(", ")}.
                Conflicting or unlinked observations are excluded from usable
                sales.
              </Alert>
            )}
            <Typography variant="body2">
              Manually reviewed observations only; seller order access is not
              connected. This is incomplete history, and does not establish
              continuous exposure, sale probability or time to sell.
            </Typography>
            <details>
              <summary>
                Observation details ({review.observations.length})
              </summary>
              {review.observations.map((row, index) => (
                <Typography key={index} variant="body2">
                  {row.id} · listing {row.itemId} · {words(row.kind)} ·{" "}
                  {row.occurredAt} ·{" "}
                  {amount(row.price?.amount, row.price?.currency ?? null)} ·{" "}
                  {words(row.source)} · first recorded {row.observedAt} ·{" "}
                  {row.note}
                  {row.relatedSaleId && ` · related sale ${row.relatedSaleId}`}
                  {row.nextItemId && ` · relisted as ${row.nextItemId}`}
                </Typography>
              ))}
            </details>
          </>
        )}
      </Stack>
    </Paper>
  );
}
