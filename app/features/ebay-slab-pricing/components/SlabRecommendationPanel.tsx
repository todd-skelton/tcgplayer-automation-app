import { useState } from "react";
import {
  Alert,
  Button,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { EvidenceStatus } from "../evidence/evidenceRefreshStore.server";
import { normalizeEvidenceSpec } from "../evidence/evidenceRefresh";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { StoredSlabRecommendation } from "../valuation/slabRecommendations.server";
import {
  DEFAULT_SLAB_POLICY,
  type SellerPriceContext,
  type ValuationPolicy,
} from "../valuation/slabValuation";
import type { SlabListing } from "./SlabInventoryPanel";
import {
  amount,
  optionalNumber,
  slabRequest,
  useSlabAction,
  words,
  type Json,
} from "./slabClient";

const costFields = [
  "currentAsk",
  "shippingCharged",
  "shippingCost",
  "acquisitionCost",
  "minimumAsk",
  "minimumProfit",
] as const;
const labels = {
  currentAsk: "Current item ask",
  shippingCharged: "Shipping charged",
  shippingCost: "Shipping cost",
  acquisitionCost: "Acquisition cost",
  minimumAsk: "Minimum item ask",
  minimumProfit: "Minimum profit",
};
export function SlabRecommendationPanel({
  record,
  listing,
  initial,
  revisions,
  canCalculate,
  reviewVersion,
  statuses,
}: {
  record: Json<StoredSlabIdentity>;
  listing: SlabListing | null;
  initial: Json<StoredSlabRecommendation> | null;
  revisions: string[];
  canCalculate: boolean;
  reviewVersion: number;
  statuses: Json<EvidenceStatus[]>;
}) {
  const [recommendation, setRecommendation] = useState(initial);
  const [basis, setBasis] = useState<ValuationPolicy["basis"]>(
    initial?.calculation.policy.basis ?? DEFAULT_SLAB_POLICY.basis,
  );
  const [fields, setFields] = useState(
    () =>
      Object.fromEntries(
        costFields.map((key) => {
          const previous = initial?.calculation.seller[key];
          const value =
            key === "currentAsk" && listing
              ? listing.snapshot.price.currency === "USD"
                ? listing.snapshot.price.amount
                : null
              : key === "shippingCharged" && listing
                ? listing.snapshot.shipping.currency === "USD"
                  ? listing.snapshot.shipping.amount
                  : null
                : previous;
          return [key, value == null ? "" : String(value)];
        }),
      ) as Record<(typeof costFields)[number], string>,
  );
  const [feeRate, setFeeRate] = useState(
    initial?.calculation.seller.fees
      ? String(initial.calculation.seller.fees.rate * 100)
      : "",
  );
  const [feeFixed, setFeeFixed] = useState(
    initial?.calculation.seller.fees
      ? String(initial.calculation.seller.fees.fixed)
      : "",
  );
  const [feeBasis, setFeeBasis] = useState<ValuationPolicy["basis"]>(
    initial?.calculation.seller.fees?.basis ?? "item-plus-shipping",
  );
  const [dirty, setDirty] = useState(
    () =>
      !!initial &&
      costFields.some(
        (key) =>
          optionalNumber(fields[key]) !== initial.calculation.seller[key],
      ),
  );
  const [calculatedReviewVersion, setCalculatedReviewVersion] =
    useState(reviewVersion);
  const [override, setOverride] = useState("");
  const [note, setNote] = useState("");
  const action = useSlabAction();
  const calculation = recommendation?.calculation;
  const stale =
    recommendation &&
    (!recommendation.current ||
      dirty ||
      calculatedReviewVersion !== reviewVersion ||
      (canCalculate &&
        (revisions.length !== recommendation.calculation.evidence.length ||
          recommendation.calculation.evidence.some(
            (e) => !revisions.includes(e.revisionId),
          ))) ||
      recommendation.calculation.evidence.some(
        (e) =>
          !e.expiresAt ||
          Date.parse(e.expiresAt) <= Date.now() ||
          statuses.some(
            (s) =>
              JSON.stringify(normalizeEvidenceSpec(s.spec)) ===
                JSON.stringify(normalizeEvidenceSpec(e.spec)) &&
              (s.latestRevision !== e.revisionId || s.stale),
          ),
      ) ||
      recommendation.calculation.identity.revision !== record.revision);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Owned slab recommendation · USD</Typography>
        <Typography variant="body2">
          Blank costs stay unknown. Market value and your proposed item ask are
          calculated separately. Saved decisions do not publish prices to eBay.
        </Typography>
        {listing && (
          <Typography variant="body2">
            Listing {listing.itemId} · {listing.snapshot.title} · Observed{" "}
            {new Date(listing.observedAt).toLocaleString()}
          </Typography>
        )}
        <fieldset
          disabled={action.busy}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <Stack spacing={2}>
            <Stack direction="row" useFlexGap flexWrap="wrap" gap={2}>
              <TextField
                select
                label="Comparable price basis"
                size="small"
                value={basis}
                onChange={(e) => {
                  setBasis(e.target.value as ValuationPolicy["basis"]);
                  setDirty(true);
                }}
              >
                <MenuItem value="item-plus-shipping">Item + shipping</MenuItem>
                <MenuItem value="item-only">Item only</MenuItem>
              </TextField>
              {costFields.map((key) => (
                <TextField
                  key={key}
                  label={`${labels[key]} (USD)`}
                  size="small"
                  type="number"
                  value={fields[key]}
                  inputProps={{ min: 0, step: 0.01 }}
                  onChange={(e) => {
                    setFields({ ...fields, [key]: e.target.value });
                    setDirty(true);
                  }}
                />
              ))}
            </Stack>
            <Stack direction="row" useFlexGap flexWrap="wrap" gap={2}>
              <TextField
                label="Seller fee (%)"
                size="small"
                type="number"
                value={feeRate}
                inputProps={{ min: 0, max: 99.99, step: 0.01 }}
                onChange={(e) => {
                  setFeeRate(e.target.value);
                  setDirty(true);
                }}
              />
              <TextField
                label="Fixed fee (USD)"
                size="small"
                type="number"
                value={feeFixed}
                inputProps={{ min: 0, step: 0.01 }}
                onChange={(e) => {
                  setFeeFixed(e.target.value);
                  setDirty(true);
                }}
              />
              <TextField
                select
                label="Fee basis"
                size="small"
                value={feeBasis}
                onChange={(e) => {
                  setFeeBasis(e.target.value as ValuationPolicy["basis"]);
                  setDirty(true);
                }}
              >
                <MenuItem value="item-plus-shipping">Item + shipping</MenuItem>
                <MenuItem value="item-only">Item only</MenuItem>
              </TextField>
            </Stack>
            <Button
              variant="contained"
              sx={{ alignSelf: "start" }}
              disabled={!canCalculate || action.busy || revisions.length > 20}
              onClick={() =>
                void action.run(async () => {
                  if (!!feeRate.trim() !== !!feeFixed.trim())
                    throw new Error(
                      "Provide both fee percentage and fixed fee, or leave both unknown.",
                    );
                  const seller = {
                    currency: "USD",
                    ...Object.fromEntries(
                      costFields.map((key) => [
                        key,
                        optionalNumber(fields[key]),
                      ]),
                    ),
                    fees: feeRate.trim()
                      ? {
                          rate: Number(feeRate) / 100,
                          fixed: Number(feeFixed),
                          basis: feeBasis,
                        }
                      : null,
                  } as SellerPriceContext;
                  const result = await slabRequest<{ id: string }>(
                    "/api/slab-recommendations",
                    {
                      intent: "calculate",
                      slabId: record.id,
                      identityRevision: record.revision,
                      revisionIds: revisions,
                      policy: { ...DEFAULT_SLAB_POLICY, basis },
                      seller,
                    },
                  );
                  const saved = await slabRequest<StoredSlabRecommendation>(
                    `/api/slab-recommendations?id=${result.id}`,
                  );
                  setRecommendation(saved);
                  setDirty(false);
                  setCalculatedReviewVersion(reviewVersion);
                })
              }
            >
              Calculate from saved evidence
            </Button>
          </Stack>
        </fieldset>
        {!canCalculate && (
          <Alert severity="info">
            Confirm the owned identity, assign it to the selected listing if
            needed, and return to its grade to calculate.
          </Alert>
        )}
        {action.error && <Alert severity="error">{action.error}</Alert>}
        {calculation && (
          <>
            {stale && (
              <Alert severity="warning">
                Inputs or evidence changed. This saved recommendation needs
                recalculation.
              </Alert>
            )}
            <Typography variant="h5">
              {calculation.market.range
                ? `${amount(calculation.market.range.low)}–${amount(calculation.market.range.high)}`
                : "Insufficient comparable evidence"}
            </Typography>
            <Typography variant="body2">
              {words(calculation.market.basis)} market range ·{" "}
              {calculation.market.count} accepted events ·{" "}
              {calculation.market.effectiveCount.toFixed(2)} recency-weighted
              events · Calculated{" "}
              {new Date(calculation.market.asOf).toLocaleString()}
            </Typography>
            {calculation.market.range && (
              <Typography variant="body2">
                The range describes the middle half of weighted observed sales;
                it is not a calibrated prediction interval.
              </Typography>
            )}
            <Typography>
              Proposed item ask: {amount(calculation.ask.proposedItemAsk)}
            </Typography>
            <Typography variant="body2">
              Estimated proceeds: {amount(calculation.ask.estimatedProceeds)} ·
              Estimated profit: {amount(calculation.ask.estimatedProfit)}
            </Typography>
            {calculation.market.observedSpan && (
              <Typography variant="body2">
                Observed sale span:{" "}
                {amount(calculation.market.observedSpan.low)}–
                {amount(calculation.market.observedSpan.high)}
              </Typography>
            )}
            {[
              ...new Set(
                [...calculation.market.flags, ...calculation.ask.flags].map(
                  (f) => f.code,
                ),
              ),
            ].length > 0 && (
              <Alert
                severity={calculation.ask.requiresReview ? "warning" : "info"}
              >
                {[
                  ...new Set(
                    [...calculation.market.flags, ...calculation.ask.flags].map(
                      (f) => words(f.code),
                    ),
                  ),
                ].join("; ")}
              </Alert>
            )}
            <Typography variant="body2">
              {
                calculation.dispositions.filter(
                  (d) => d.status === "needs-review",
                ).length
              }{" "}
              uncertain events ·{" "}
              {
                calculation.dispositions.filter((d) => d.status === "rejected")
                  .length
              }{" "}
              excluded events. Review the source rows below for reasons.
            </Typography>
            <CalculationEvidence
              key={recommendation!.id}
              calculation={calculation}
            />
            {recommendation?.override && (
              <Alert severity="info">
                Reviewed item ask:{" "}
                {amount(
                  recommendation.override.itemPrice,
                  recommendation.override.currency,
                )}{" "}
                · {recommendation.override.note}. Proceeds and profit above
                belong to the original calculation.
              </Alert>
            )}
            <Stack direction="row" gap={2} useFlexGap flexWrap="wrap">
              <TextField
                size="small"
                label="Override item ask (USD)"
                type="number"
                value={override}
                onChange={(e) => setOverride(e.target.value)}
              />
              <TextField
                size="small"
                label="Override reason"
                value={note}
                inputProps={{ maxLength: 1000 }}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                disabled={
                  action.busy ||
                  !canCalculate ||
                  !override.trim() ||
                  !note.trim() ||
                  !!stale
                }
                onClick={() =>
                  void action.run(async () => {
                    const result = await slabRequest<StoredSlabRecommendation>(
                      "/api/slab-recommendations",
                      {
                        intent: "override",
                        recommendationId: recommendation!.id,
                        itemPrice: Number(override),
                        currency: "USD",
                        note,
                      },
                    );
                    setRecommendation(result);
                    setOverride("");
                    setNote("");
                  })
                }
              >
                Save reviewed ask
              </Button>
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
}

function CalculationEvidence({
  calculation,
}: {
  calculation: StoredSlabRecommendation["calculation"];
}) {
  const [page, setPage] = useState(0);
  const rows = [
    ...calculation.market.comps.map((comp) => ({
      key: comp.key,
      text: `Accepted: ${amount(comp.amount, comp.currency)} on ${comp.date}; recency weight ${comp.weight.toFixed(3)}. ${comp.references.map((r) => `${r.provider} ${r.providerId}`).join(", ")}`,
    })),
    ...calculation.dispositions.map((comp) => ({
      key: comp.key,
      text: `${words(comp.status)}: ${comp.reasons.map(words).join("; ")}. ${comp.references.map((r) => `${r.provider} ${r.providerId}`).join(", ")}`,
    })),
    ...calculation.market.excluded.map((comp) => ({
      key: comp.key,
      text: `Excluded from range: ${words(comp.reason)}. ${comp.key}`,
    })),
  ];
  return (
    <details>
      <summary>How this calculation used the evidence</summary>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {rows.slice(page * 25, (page + 1) * 25).map((row, i) => (
          <Typography
            key={`${row.key}:${i}`}
            variant="body2"
            sx={{ overflowWrap: "anywhere" }}
          >
            {row.text}
          </Typography>
        ))}
        {!rows.length && (
          <Typography variant="body2">
            No comparable events were supplied.
          </Typography>
        )}
        {rows.length > 25 && (
          <Stack direction="row" gap={2}>
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous decisions
            </Button>
            <Button
              disabled={(page + 1) * 25 >= rows.length}
              onClick={() => setPage(page + 1)}
            >
              Next decisions
            </Button>
          </Stack>
        )}
      </Stack>
    </details>
  );
}
