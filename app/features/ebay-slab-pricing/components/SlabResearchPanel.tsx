import { lazy, Suspense, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { EvidenceStatus } from "../evidence/evidenceRefreshStore.server";
import type { SlabWorkspace } from "../research/slabResearch.server";
import type { SlabListing } from "./SlabInventoryPanel";
import { SlabRecommendationPanel } from "./SlabRecommendationPanel";
import {
  slabRequest,
  useSlabAction,
  words,
  defaultResearchWindow,
  type Json,
} from "./slabClient";
const CompReview = lazy(() => import("./SlabCompReview"));
const SupplyPanel = lazy(() => import("./SlabSupplyPanel"));
export function SlabResearchPanel({
  record,
  listing,
}: {
  record: Json<StoredSlabIdentity>;
  listing: SlabListing | null;
}) {
  const [grade, setGrade] = useState("owned");
  const [window, setWindow] = useState(defaultResearchWindow);
  const [workspace, setWorkspace] = useState<Json<SlabWorkspace> | null>(null);
  const [statuses, setStatuses] = useState<Json<EvidenceStatus[]>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [reload, setReload] = useState(0);
  const [showSupply, setShowSupply] = useState(false);
  const action = useSlabAction();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void slabRequest<SlabWorkspace>(
      `/api/slab-workspace?${new URLSearchParams({ id: record.id, grade, ...window })}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setWorkspace(value);
          setStatuses(value.statuses);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [record.id, record.revision, grade, window.from, window.to, reload]);
  const keys = statuses
    .map((s) => s.key)
    .sort()
    .join(",");
  const pending = statuses.some(
    (s) => s.state === "queued" || s.state === "running",
  );
  useEffect(() => {
    if (!pending || loading) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await slabRequest<{ statuses: EvidenceStatus[] }>(
          `/api/slab-evidence?${new URLSearchParams({ keys })}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatuses(result.statuses);
        if (
          result.statuses.some(
            (s) => s.state === "queued" || s.state === "running",
          )
        )
          timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : "Unable to refresh evidence status.",
          );
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [keys, pending, loading, reload]);
  const canReview =
    grade === "owned" &&
    record.status === "confirmed" &&
    workspace?.record.revision === record.revision &&
    !loading &&
    !error;
  const additional = (incoming: Json<EvidenceStatus[]>) => {
    setStatuses((current) => [
      ...current.filter((s) => !incoming.some((next) => next.key === s.key)),
      ...incoming,
    ]);
  };
  const revisions = [
    ...new Set(
      statuses.flatMap((s) => (s.latestRevision ? [s.latestRevision] : [])),
    ),
  ];
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Research evidence</Typography>
          <Stack direction="row" useFlexGap flexWrap="wrap" gap={2}>
            <TextField
              select
              label="Research grade"
              size="small"
              disabled={action.busy}
              value={grade}
              onChange={(e) => {
                setSelected(null);
                setGrade(e.target.value);
              }}
            >
              <MenuItem value="owned">
                Owned {record.grader}{" "}
                {
                  (record.identity ?? record.candidate?.identity)?.grading
                    .encoding
                }
              </MenuItem>
              {record.grader === "PSA" &&
                [
                  1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8,
                  8.5, 9, 10,
                ].map((n) => (
                  <MenuItem key={n} value={String(n)}>
                    Explore PSA {n}
                  </MenuItem>
                ))}
            </TextField>
            {(["from", "to"] as const).map((field) => (
              <TextField
                key={field}
                label={field === "from" ? "Sales from" : "Sales through"}
                type="date"
                size="small"
                disabled={action.busy}
                slotProps={{ inputLabel: { shrink: true } }}
                value={window[field]}
                onChange={(e) => (
                  setSelected(null),
                  setWindow({ ...window, [field]: e.target.value })
                )}
              />
            ))}
          </Stack>
          {grade !== "owned" && (
            <Alert severity="info">
              Exploring PSA {grade}. Owned {record.grader}{" "}
              {
                (record.identity ?? record.candidate?.identity)?.grading
                  .encoding
              }{" "}
              is unchanged. Research evidence cannot be used to calculate or
              override the owned slab price.
            </Alert>
          )}
          <Stack direction="row" gap={2}>
            <Button
              disabled={action.busy || loading || !!error}
              variant="outlined"
              onClick={() =>
                void action.run(async () => {
                  const result = await slabRequest<{
                    statuses: EvidenceStatus[];
                  }>("/api/slab-evidence", {
                    intent: "research",
                    slabId: record.id,
                    identityRevision: record.revision,
                    grade,
                    window,
                    force: true,
                  });
                  setStatuses(result.statuses);
                })
              }
            >
              Refresh evidence
            </Button>
            <Button
              disabled={loading || action.busy}
              onClick={() => setReload(reload + 1)}
            >
              Reload saved status
            </Button>
            <Link href="/slab-connections" sx={{ alignSelf: "center" }}>
              Data connections
            </Link>
          </Stack>
          {loading && (
            <Typography role="status">Loading saved evidence…</Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {workspace && workspace.record.revision !== record.revision && (
            <Alert severity="warning">
              The identity changed elsewhere. Look up the certificate again
              before continuing; your unsaved inputs are still here.
            </Alert>
          )}
          {action.error && <Alert severity="error">{action.error}</Alert>}
          {!loading && statuses.length === 0 && (
            <Alert severity="info">
              No saved evidence for this grade and date window. Refresh to
              request it.
            </Alert>
          )}
          {statuses.map((status) => (
            <Stack
              key={status.key}
              direction="row"
              useFlexGap
              flexWrap="wrap"
              gap={1}
              alignItems="center"
            >
              <Typography>{words(status.spec.kind)}</Typography>
              <Chip size="small" label={words(status.state)} />
              <Chip
                size="small"
                label={status.stale ? "Stale or not fetched" : "Fresh"}
                color={status.stale ? "warning" : "success"}
              />
              <Typography variant="body2">
                {status.fetchedAt
                  ? new Date(status.fetchedAt).toLocaleString()
                  : "Not yet fetched"}
                {status.errorCode ? ` · ${words(status.errorCode)}` : ""}
              </Typography>
              {status.latestRevision && (
                <Button
                  size="small"
                  disabled={loading}
                  onClick={() => setSelected(status.latestRevision)}
                >
                  Review saved comps
                </Button>
              )}
              {(status.state === "queued" || status.state === "running") && (
                <Button
                  size="small"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await slabRequest("/api/slab-evidence", {
                        intent: "cancel",
                        key: status.key,
                        runId: status.runId,
                      });
                      const result = await slabRequest<{
                        statuses: EvidenceStatus[];
                      }>(`/api/slab-evidence?${new URLSearchParams({ keys })}`);
                      setStatuses(result.statuses);
                    })
                  }
                >
                  Cancel refresh
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      </Paper>
      {workspace?.gradeModel && (
        <Alert severity="info">
          Cross-grade estimate unavailable. {workspace.gradeModel.reason}
        </Alert>
      )}
      <Button
        sx={{ alignSelf: "start" }}
        onClick={() => setShowSupply((v) => !v)}
      >
        {showSupply ? "Hide supply context" : "Show supply context"}
      </Button>
      {showSupply && (
        <Suspense fallback={<Typography>Loading supply context…</Typography>}>
          <SupplyPanel
            key={`${record.id}:${record.revision}:${grade}:${window.from}:${window.to}:${listing?.seller ?? "pokebash"}`}
            record={record}
            grade={grade}
            window={window}
            seller={listing?.seller ?? "pokebash"}
          />
        </Suspense>
      )}
      {workspace && (
        <SlabRecommendationPanel
          record={record}
          listing={listing}
          initial={workspace.recommendation}
          revisions={revisions}
          canCalculate={
            !!canReview && (!listing || listing.identityId === record.id)
          }
          reviewVersion={reviewVersion}
          statuses={grade === "owned" ? statuses : []}
        />
      )}
      {selected && workspace && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Suspense fallback={<Typography>Loading comp review…</Typography>}>
            <CompReview
              key={`${selected}:${grade}`}
              revisionId={selected}
              target={workspace.target}
              canReview={!!canReview}
              onChanged={() => setReviewVersion((v) => v + 1)}
              onAdditional={additional}
            />
          </Suspense>
        </Paper>
      )}
    </Stack>
  );
}
