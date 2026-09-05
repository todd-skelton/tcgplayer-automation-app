import { createHash } from "node:crypto";
import {
  createAltEvidenceForRun,
  createEbayResearchForRun,
} from "./slabEvidence.server";
import {
  normalizeEvidenceSpec,
  EvidenceRefreshError,
  type EvidenceSpec,
} from "./evidenceRefresh";
import type { SaleEvidence, SupplyEvidence } from "./slabEvidence";

type Alt = ReturnType<typeof createAltEvidenceForRun>;
type Ebay = ReturnType<typeof createEbayResearchForRun>;
export type EvidencePayload =
  | { kind: "alt-sales"; data: Awaited<ReturnType<Alt["getSales"]>> }
  | { kind: "alt-supply"; data: Awaited<ReturnType<Alt["getSupply"]>> }
  | { kind: "alt-sale-detail"; data: Awaited<ReturnType<Alt["getSaleDetail"]>> }
  | { kind: "ebay-sales"; data: Awaited<ReturnType<Ebay["getSalesPage"]>> }
  | { kind: "ebay-supply"; data: Awaited<ReturnType<Ebay["getSupplyPage"]>> };
export function evidenceKey(input: EvidenceSpec) {
  const spec = normalizeEvidenceSpec(input);
  const context = spec.kind.startsWith("alt-")
    ? { market: "global", currency: "reported" }
    : { market: "EBAY-US", currency: "USD", category: "0" };
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, context, spec }))
    .digest("hex");
}
export async function fetchEvidence(
  spec: EvidenceSpec,
  signal: AbortSignal,
): Promise<EvidencePayload> {
  switch (spec.kind) {
    case "alt-sales":
      return {
        kind: spec.kind,
        data: await createAltEvidenceForRun(signal).getSales(
          spec.assetId,
          spec.window,
          spec.limitPerGrade,
        ),
      };
    case "alt-supply":
      return {
        kind: spec.kind,
        data: await createAltEvidenceForRun(signal).getSupply(spec.assetId),
      };
    case "alt-sale-detail":
      return {
        kind: spec.kind,
        data: await createAltEvidenceForRun(signal).getSaleDetail(
          spec.transactionId,
        ),
      };
    case "ebay-sales":
      return {
        kind: spec.kind,
        data: await createEbayResearchForRun(signal).getSalesPage(spec),
      };
    case "ebay-supply":
      return {
        kind: spec.kind,
        data: await createEbayResearchForRun(signal).getSupplyPage(spec),
      };
  }
}
export function compactEvidence(payload: EvidencePayload) {
  // Collapse repeated copies within one response only; independent events and snapshots survive.
  let rows: Array<SaleEvidence | SupplyEvidence> = [];
  if (
    payload.kind === "alt-sales" ||
    (payload.kind === "ebay-sales" && payload.data.status === "sold")
  )
    rows = payload.data.sales!;
  if (payload.kind === "alt-supply" || payload.kind === "ebay-supply")
    rows = payload.data.listings;
  if (payload.kind === "alt-sale-detail" && payload.data) rows = [payload.data];
  if (rows.length > 2000)
    throw new EvidenceRefreshError(
      "Evidence response exceeds the observation limit.",
    );
  const unique = new Map<string, SaleEvidence | SupplyEvidence>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.provider,
      row.providerId,
      "kind" in row ? row.kind : "supply",
      "date" in row ? row.date : null,
    ]);
    const previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      throw new EvidenceRefreshError(
        "Evidence source returned conflicting copies of one event.",
      );
    unique.set(key, row);
  }
  if (
    payload.kind === "alt-sales" ||
    (payload.kind === "ebay-sales" && payload.data.status === "sold")
  )
    payload = {
      ...payload,
      data: { ...payload.data, sales: [...unique.values()] as SaleEvidence[] },
    } as EvidencePayload;
  if (payload.kind === "alt-supply" || payload.kind === "ebay-supply")
    payload = {
      ...payload,
      data: {
        ...payload.data,
        listings: [...unique.values()] as SupplyEvidence[],
      },
    } as EvidencePayload;
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json);
  if (bytes > 1024 * 1024)
    throw new EvidenceRefreshError(
      "Normalized evidence exceeds the storage limit.",
    );
  return { payload, json, bytes, observations: unique.size };
}

export function validateEvidencePayload(
  spec: EvidenceSpec,
  payload: EvidencePayload,
) {
  const invalid = () =>
    new EvidenceRefreshError(
      "Evidence does not match the requested identity, window or page.",
    );
  if (spec.kind !== payload.kind) throw invalid();
  if (spec.kind === "alt-sales" && payload.kind === "alt-sales") {
    if (
      payload.data.coverage.requestedWindow.from !== spec.window.from ||
      payload.data.coverage.requestedWindow.to !== spec.window.to ||
      payload.data.coverage.limitPerGrade !== spec.limitPerGrade ||
      payload.data.sales.some(
        (row) => row.provider !== "alt" || row.assetId !== spec.assetId,
      )
    )
      throw invalid();
  }
  if (
    spec.kind === "alt-supply" &&
    payload.kind === "alt-supply" &&
    payload.data.listings.some(
      (row) => row.provider !== "alt" || row.assetId !== spec.assetId,
    )
  )
    throw invalid();
  if (
    spec.kind === "alt-sale-detail" &&
    payload.kind === "alt-sale-detail" &&
    payload.data &&
    (payload.data.provider !== "alt" ||
      payload.data.providerId !== spec.transactionId)
  )
    throw invalid();
  if (
    (spec.kind === "ebay-sales" || spec.kind === "ebay-supply") &&
    (payload.kind === "ebay-sales" || payload.kind === "ebay-supply")
  ) {
    if (payload.data.status === "active-fallback")
      throw new EvidenceRefreshError(
        "eBay fell back to active listings; prior sold evidence was retained.",
      );
    if (
      payload.data.keywords !== spec.keywords ||
      !payload.data.page ||
      payload.data.page.offset !== spec.offset ||
      payload.data.page.limit !== spec.limit
    )
      throw invalid();
    if (
      payload.kind === "ebay-sales" &&
      (payload.data.coverage?.requestedWindow.from !== spec.window.from ||
        payload.data.coverage?.requestedWindow.to !== spec.window.to ||
        payload.data.sales?.some((row) => row.provider !== "ebayResearch"))
    )
      throw invalid();
  }
}
