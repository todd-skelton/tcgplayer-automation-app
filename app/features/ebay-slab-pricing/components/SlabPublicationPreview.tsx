import { useEffect, useRef, useState } from "react";
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
import type { InventoryRow } from "../inventory/slabInventory.server";
import type { StoredSlabRecommendation } from "../valuation/slabRecommendations.server";
import type { SlabPublicationPreview } from "../publication/slabPublicationPreviews.server";
import { SlabPublicationDryRun } from "./SlabPublicationDryRun";
import {
  amount,
  slabRequest,
  useSlabAction,
  words,
  type Json,
} from "./slabClient";
export default function SlabPublicationPreviewPanel({
  listing,
  recommendation,
  stale,
}: {
  listing: Json<InventoryRow>;
  recommendation: Json<StoredSlabRecommendation>;
  stale: boolean;
}) {
  const [selection, setSelection] = useState<"calculated" | "reviewed">(
    recommendation.override ? "reviewed" : "calculated",
  );
  const [saved, setSaved] = useState<Json<SlabPublicationPreview> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const pendingIntent = useRef<string | null>(null);
  const action = useSlabAction();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void slabRequest<SlabPublicationPreview | null>(
      `/api/slab-publication-previews?inventoryId=${listing.id}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setSaved(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Unable to load the saved preview.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listing.id, reload]);
  const plan = saved?.plan;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Review a listing price change</Typography>
        <Typography variant="body2">
          Save the selected ask with this listing and its evidence. A preview
          uses imported inventory; a live seller read is still required before
          approval.
        </Typography>
        <Stack direction="row" gap={2} useFlexGap flexWrap="wrap">
          <TextField
            select
            size="small"
            label="Price to review"
            value={selection}
            disabled={action.busy || loading}
            onChange={(e) => {
              setSelection(e.target.value as typeof selection);
              pendingIntent.current = null;
            }}
          >
            <MenuItem value="calculated">
              Calculated ask ·{" "}
              {amount(recommendation.calculation.ask.proposedItemAsk)}
            </MenuItem>
            {recommendation.override && (
              <MenuItem value="reviewed">
                Reviewed ask · {amount(recommendation.override.itemPrice)}
              </MenuItem>
            )}
          </TextField>
          <Button
            disabled={action.busy || loading || stale}
            onClick={() =>
              void action.run(async () => {
                pendingIntent.current ??= crypto.randomUUID();
                const value = await slabRequest<SlabPublicationPreview>(
                  "/api/slab-publication-previews",
                  {
                    intent: "prepare",
                    intentId: pendingIntent.current,
                    inventoryId: listing.id,
                    inventoryRevision: listing.revision,
                    recommendationId: recommendation.id,
                    selection,
                    overrideReviewedAt:
                      selection === "reviewed"
                        ? recommendation.override?.reviewedAt
                        : null,
                  },
                );
                setSaved(value);
                pendingIntent.current = null;
              })
            }
          >
            Save price-change preview
          </Button>
          <Button
            disabled={action.busy || loading}
            onClick={() => setReload((v) => v + 1)}
          >
            Reload preview
          </Button>
        </Stack>
        {loading && (
          <Typography role="status">Loading saved preview…</Typography>
        )}
        {(action.error || loadError) && (
          <Alert severity="error">{action.error ?? loadError}</Alert>
        )}
        {stale && (
          <Alert severity="warning">
            Recalculate using the current listing and evidence before preparing
            another price change.
          </Alert>
        )}
        {saved && plan && (
          <>
            <Typography>
              <Link
                href={`https://www.ebay.com/itm/${plan.inventory.itemId}`}
                target="_blank"
                rel="noreferrer"
              >
                {plan.inventory.snapshot.title}
              </Link>{" "}
              · {plan.inventory.seller}
            </Typography>
            <Typography>
              {amount(plan.oldPrice.amount)} → {amount(plan.newPrice.amount)} (
              {plan.changePercent > 0 ? "+" : ""}
              {plan.changePercent.toFixed(1)}%) · {words(plan.selection)} ask
            </Typography>
            <Typography variant="body2">
              Quantity {plan.inventory.snapshot.quantity} ·{" "}
              {words(plan.inventory.snapshot.format)} · Inventory revision{" "}
              {plan.inventory.revision} · Identity revision{" "}
              {plan.identity.revision}
            </Typography>
            <Typography variant="body2">
              Saved {new Date(plan.createdAt).toLocaleString()} · Review expires{" "}
              {new Date(plan.expiresAt).toLocaleString()} ·{" "}
              {plan.evidence.length} evidence revisions
            </Typography>
            {plan.override && (
              <Typography variant="body2">
                Review reason: {plan.override.note}
              </Typography>
            )}
            {plan.flags.length > 0 && (
              <Alert severity="info">{plan.flags.map(words).join("; ")}</Alert>
            )}
            {saved.conflicts.length > 0 && (
              <Alert severity="warning">
                Preview needs replacement:{" "}
                {saved.conflicts.map(words).join("; ")}.
              </Alert>
            )}
            <Typography variant="caption">
              Preview {saved.id} · {plan.policyVersion} · {plan.version}
            </Typography>
            <SlabPublicationDryRun
              key={saved.id}
              previewId={saved.id}
              disabled={
                stale ||
                saved.conflicts.length > 0 ||
                Date.parse(plan.expiresAt) <= Date.now()
              }
            />
          </>
        )}
        <Alert severity="info">
          Seller OAuth and live listing readback are not connected. Publishing
          is unavailable; saved previews cannot write to eBay.
        </Alert>
      </Stack>
    </Paper>
  );
}
