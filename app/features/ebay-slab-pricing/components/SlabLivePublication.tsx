import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  Typography,
} from "@mui/material";
import type {
  StoredPublication,
  listingPublicationHistory,
} from "../publication/slabPublicationStore.server";
import type { sellerPublicationStatus } from "../publication/ebaySlabPublication.server";
import {
  slabRequest,
  useSlabAction,
  amount,
  words,
  type Json,
} from "./slabClient";
export function SlabLivePublication({
  previewId,
  inventoryId,
  disabled,
}: {
  previewId: string;
  inventoryId: string;
  disabled: boolean;
}) {
  const [capabilities, setCapabilities] = useState<ReturnType<
    typeof sellerPublicationStatus
  > | null>(null);
  const [history, setHistory] = useState<
    Json<Awaited<ReturnType<typeof listingPublicationHistory>>>
  >([]);
  const [selected, setSelected] = useState<Json<StoredPublication> | null>(
      null,
    ),
    [confirmed, setConfirmed] = useState(false),
    [reload, setReload] = useState(0),
    [error, setError] = useState<string | null>(null);
  const intent = useRef<{ id: string; restoreOf: string | null } | null>(null),
    action = useSlabAction();
  useEffect(() => {
    const controller = new AbortController();
    void slabRequest<{
      capabilities: ReturnType<typeof sellerPublicationStatus>;
      publications: Awaited<ReturnType<typeof listingPublicationHistory>>;
    }>(
      `/api/slab-publications?inventoryId=${inventoryId}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setCapabilities(value.capabilities);
          setHistory(value.publications);
          setError(null);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Publication status unavailable.",
          );
      });
    return () => controller.abort();
  }, [inventoryId, reload]);
  const choose = async (id: string) => {
    const value = await slabRequest<{
      publication: StoredPublication;
      capabilities: ReturnType<typeof sellerPublicationStatus>;
    }>(`/api/slab-publications?id=${id}`);
    setSelected(value.publication);
    setCapabilities(value.capabilities);
    setConfirmed(false);
  };
  const prepare = async (restoreOf?: string) => {
    if (!intent.current || intent.current.restoreOf !== (restoreOf ?? null))
      intent.current = {
        id: crypto.randomUUID(),
        restoreOf: restoreOf ?? null,
      };
    const result = await slabRequest<StoredPublication>(
      "/api/slab-publications",
      {
        intent: "prepare-live",
        intentId: intent.current.id,
        previewId,
        ...(restoreOf ? { restoreOf } : {}),
      },
    );
    intent.current = null;
    setSelected(result);
    setConfirmed(false);
    setReload((value) => value + 1);
  };
  const perform = async (operation: "approve" | "reconcile" | "cancel") => {
    if (!selected) return;
    const result = await slabRequest<StoredPublication>(
      "/api/slab-publications",
      {
        intent: operation,
        id: selected.id,
        ...(operation === "approve" ? { confirmation: selected.id } : {}),
      },
    );
    setSelected(result);
    setConfirmed(false);
    setReload((value) => value + 1);
  };
  const canApprove =
    selected &&
    !selected.writeStartedAt &&
    ["prepared", "approved", "checking"].includes(selected.state);
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle1">Reviewed eBay publication</Typography>
      {(error || action.error) && (
        <Alert severity="error">{error ?? action.error}</Alert>
      )}
      {!capabilities?.sellerConfigured ? (
        <Typography>
          Seller OAuth is not configured. Live listing verification is
          unavailable.
        </Typography>
      ) : (
        <>
          {!capabilities.reviewedWritesEnabled && (
            <Alert severity="info">
              Reviewed publishing is disabled. You can prepare a live review and
              reconcile an earlier possible write.
            </Alert>
          )}
          <Typography variant="body2">
            Current support is limited to US, USD, single-quantity fixed-price
            listings without SKUs or variations. Other listing origins remain in
            review.
          </Typography>
          <Button
            disabled={disabled || action.busy}
            onClick={() => void action.run(() => prepare())}
          >
            Read eBay and prepare review
          </Button>
        </>
      )}
      <Button
        disabled={action.busy}
        onClick={() => setReload((value) => value + 1)}
      >
        Reload listing publication history
      </Button>
      {history.map((row) => (
        <Button
          key={row.id}
          disabled={action.busy}
          onClick={() => void action.run(() => choose(row.id))}
        >
          {words(row.state)} · {new Date(row.createdAt).toLocaleString()}
        </Button>
      ))}
      {selected && (
        <>
          <Typography>
            {selected.plan.target.seller} · Listing{" "}
            {selected.plan.target.itemId} ·{" "}
            {amount(
              selected.plan.before.price.amount,
              selected.plan.before.price.currency,
            )}{" "}
            → {amount(selected.plan.price.amount, selected.plan.price.currency)}
          </Typography>
          <Typography variant="body2">
            Certificate {selected.plan.certificate.grader}{" "}
            {selected.plan.certificate.certificateNumber} · Quantity{" "}
            {selected.plan.before.quantity} · {selected.plan.before.title}
          </Typography>
          <Typography variant="body2">
            {words(selected.state)}
            {selected.reason ? ` · ${words(selected.reason)}` : ""} · Review
            expires {new Date(selected.plan.expiresAt).toLocaleString()}
          </Typography>
          {canApprove && (
            <>
              <Alert severity="warning">
                eBay does not provide an atomic compare-and-update for this
                call. External edits can race the final read; the app checks the
                resulting price and protected fields afterward.
              </Alert>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                }
                label="I reviewed this seller, listing, certificate and exact price change."
              />
              <Button
                disabled={
                  action.busy ||
                  !confirmed ||
                  !capabilities?.reviewedWritesEnabled ||
                  Date.parse(selected.plan.expiresAt) <= Date.now()
                }
                onClick={() => void action.run(() => perform("approve"))}
              >
                Approve and publish this price
              </Button>
              <Button
                disabled={action.busy}
                onClick={() => void action.run(() => perform("cancel"))}
              >
                Cancel this intent
              </Button>
            </>
          )}
          {selected.writeStartedAt &&
            ["writing", "reconcile"].includes(selected.state) && (
              <Button
                disabled={action.busy || !capabilities?.sellerConfigured}
                onClick={() => void action.run(() => perform("reconcile"))}
              >
                Read eBay to reconcile without resending
              </Button>
            )}
          {selected.state === "confirmed" && (
            <>
              <Typography variant="body2">
                To restore {amount(selected.plan.before.price.amount)}, first
                save a fresh preview selecting that prior price. The restore
                gets its own review and approval.
              </Typography>
              <Button
                disabled={
                  action.busy || disabled || !capabilities?.sellerConfigured
                }
                onClick={() => void action.run(() => prepare(selected.id))}
              >
                Prepare restore from this preview
              </Button>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
