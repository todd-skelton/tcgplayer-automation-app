import type {
  HistoricalOrderRevisionEvidence,
  HistoricalPublicationAdditionEvidence,
  HistoricalPublicationEstimate,
  HistoricalPublicationEstimateAllocation,
  HistoricalPublicationEstimateEvidence,
  HistoricalPublicationEstimateReason,
} from "../types/inventorySellingHistory";

const DAY_MS = 86_400_000;
const DETAIL_LIMIT = 50;
const SAFE_LIFECYCLES = new Set([
  "processing",
  "ready_to_ship",
  "shipped_in_transit",
  "shipped_delivered",
  "completed_paid",
]);

type Demand = {
  orderId: string;
  orderNumber: string;
  orderedAt: string;
  quantity: number;
};

type MutableLot = {
  addition: HistoricalPublicationAdditionEvidence | null;
  remaining: number;
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

function validTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function linesBySku(revision: HistoricalOrderRevisionEvidence): Map<number, number> | null {
  const result = new Map<number, number>();
  for (const line of revision.lines) {
    if (!/^[1-9][0-9]{0,9}$/.test(line.skuId)) continue;
    const sku = Number(line.skuId);
    if (!Number.isSafeInteger(sku) || sku > 2_147_483_647 ||
        !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return null;
    result.set(sku, (result.get(sku) ?? 0) + line.quantity);
  }
  return result;
}

function mapsEqual(left: Map<number, number>, right: Map<number, number>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function orderDemands(
  revisions: HistoricalOrderRevisionEvidence[],
  firstPublicationBySku: Map<number, number>,
  cutoffTime: number,
  validatedAt: string,
): { demands: Map<number, Demand[]>; conflicts: Map<number, HistoricalPublicationEstimateReason[]> } {
  const candidateSkus = new Set(firstPublicationBySku.keys());
  const byOrder = new Map<string, HistoricalOrderRevisionEvidence[]>();
  for (const revision of revisions) {
    const rows = byOrder.get(revision.orderId) ?? [];
    rows.push(revision);
    byOrder.set(revision.orderId, rows);
  }
  const demands = new Map<number, Demand[]>();
  const conflicts = new Map<number, HistoricalPublicationEstimateReason[]>();
  const addConflict = (skus: Iterable<number>, reason: HistoricalPublicationEstimateReason) => {
    for (const sku of skus) {
      if (!candidateSkus.has(sku)) continue;
      conflicts.set(sku, unique([...(conflicts.get(sku) ?? []), reason]));
    }
  };

  for (const rows of byOrder.values()) {
    rows.sort((left, right) => left.revisionNumber - right.revisionNumber);
    const parsed = rows.map((revision) => ({ revision, lines: linesBySku(revision) }));
    const affectedSkus = new Set(parsed.flatMap(({ lines }) =>
      lines ? [...lines.keys()].filter((sku) => candidateSkus.has(sku)) : []));
    if (affectedSkus.size === 0) continue;
    const windowSkus = new Set([...affectedSkus].filter((sku) => parsed.some(({ revision, lines }) => {
      const time = validTime(revision.orderTime);
      return lines?.has(sku) && time !== null &&
        time >= firstPublicationBySku.get(sku)! && time < cutoffTime;
    })));
    if (windowSkus.size === 0) continue;
    if (parsed.some(({ lines }) => lines === null)) {
      addConflict(windowSkus, "order_history_changed");
      continue;
    }
    const validationTime = Date.parse(validatedAt);
    let baselineIndex = -1;
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      if (Date.parse(parsed[index].revision.observedAt) <= validationTime) {
        baselineIndex = index;
        break;
      }
    }
    if (baselineIndex < 0) {
      addConflict(windowSkus, "order_time_unknown");
      continue;
    }
    const baseline = parsed[baselineIndex];
    const baselineTime = validTime(baseline.revision.orderTime);
    const later = parsed.slice(baselineIndex + 1);
    if (baselineTime === null || baseline.revision.orderTimeEvidence !== "detail_canonical") {
      addConflict(windowSkus, "order_time_unknown");
      continue;
    }
    const changed = later.some(({ revision, lines }) =>
      validTime(revision.orderTime) !== baselineTime || !mapsEqual(baseline.lines!, lines!));
    if (changed) {
      // A correction can move an order across both SKU and time boundaries, so
      // every candidate SKU in that order remains part of the conflict.
      addConflict(affectedSkus, "order_history_changed");
      continue;
    }
    if (!SAFE_LIFECYCLES.has(baseline.revision.lifecycle) ||
        later.some(({ revision }) => !SAFE_LIFECYCLES.has(revision.lifecycle))) {
      addConflict(windowSkus, "order_lifecycle_unsettled");
      continue;
    }
    for (const [sku, quantity] of baseline.lines!) {
      if (!candidateSkus.has(sku)) continue;
      const skuDemands = demands.get(sku) ?? [];
      skuDemands.push({
        orderId: baseline.revision.orderId,
        orderNumber: baseline.revision.orderNumber,
        orderedAt: baseline.revision.orderTime!,
        quantity,
      });
      demands.set(sku, skuDemands);
    }
  }

  for (const rows of demands.values()) rows.sort((left, right) =>
    left.orderedAt.localeCompare(right.orderedAt) ||
    left.orderNumber.localeCompare(right.orderNumber) ||
    left.orderId.localeCompare(right.orderId));
  return { demands, conflicts };
}

function publicationReasons(
  addition: HistoricalPublicationAdditionEvidence,
  cutoffTime: number,
  coverageStartTime: number,
): HistoricalPublicationEstimateReason[] {
  const confirmed = validTime(addition.confirmedAt);
  const publishing = validTime(addition.publishingAt);
  const validPublication =
    addition.sourceType === "pending_inventory" &&
    addition.method === "staged_delta" &&
    addition.quantity > 0 &&
    Boolean(addition.inventoryDeltaKey) &&
    addition.batchItemCount === 1 &&
    addition.batchAddToQuantity === addition.quantity &&
    confirmed !== null &&
    confirmed < cutoffTime &&
    (publishing === null || publishing <= confirmed);
  return [
    ...(addition.skuProductLineCount !== 1
      ? ["publication_identity_conflict" as const]
      : []),
    ...(addition.linkedPreCutoffPublicationCount > 0
      ? ["mixed_publication_receipt_sources" as const]
      : []),
    ...(!validPublication ? ["publication_evidence_invalid" as const] : []),
    ...(confirmed !== null && confirmed < coverageStartTime
      ? ["source_bounds_exceeded" as const]
      : []),
  ];
}

function emptySummary(additions: HistoricalPublicationAdditionEvidence[]) {
  const confirmed = additions.filter((row) => validTime(row.confirmedAt) !== null);
  return {
    publicationItemCount: additions.length,
    publicationQuantity: additions.reduce((sum, row) => sum + row.quantity, 0),
    confirmedAdditionCount: confirmed.length,
    confirmedAdditionQuantity: confirmed.reduce((sum, row) => sum + row.quantity, 0),
    estimatedAdditionCount: 0,
    estimatedAdditionQuantity: 0,
    unsupportedAdditionCount: additions.length,
    unsupportedAdditionQuantity: additions.reduce((sum, row) => sum + row.quantity, 0),
    estimatedSoldQuantity: 0,
    estimatedRemainingAtCutoff: 0,
    reconstructedOlderQuantity: 0,
    reconstructedOlderRemainingAtCutoff: 0,
    supportedSkuCount: 0,
    conflictedSkuCount: new Set(additions.map((row) => row.sku)).size,
  };
}

export function estimateHistoricalPublicationHistory(
  evidence: HistoricalPublicationEstimateEvidence,
): HistoricalPublicationEstimate {
  const cutoffTime = validTime(evidence.cutoffAt);
  const coverageStartTime = validTime(evidence.coverageStartsAt);
  const allAdditions = [...evidence.additions].sort((left, right) => {
    if (left.confirmedAt === null) return right.confirmedAt === null
      ? left.publicationItemId - right.publicationItemId
      : 1;
    if (right.confirmedAt === null) return -1;
    return left.confirmedAt.localeCompare(right.confirmedAt) || left.publicationItemId - right.publicationItemId;
  });
  const globalReason: HistoricalPublicationEstimateReason | undefined =
    !evidence.sourceAvailable ? "source_read_failed" :
    cutoffTime === null ? "opening_coverage_missing" :
      !evidence.coverageComplete || validTime(evidence.validatedAt) === null
        ? "order_coverage_incomplete" :
        evidence.additionCount !== evidence.additions.length ||
        evidence.orderRevisionCount !== evidence.orderRevisions.length ||
        coverageStartTime === null ? "source_bounds_exceeded" : undefined;
  if (allAdditions.length === 0 && !globalReason) {
    return {
      status: "no_data",
      cutoffAt: evidence.cutoffAt,
      summary: emptySummary([]),
      cohorts: [],
      cohortCount: 0,
      conflicts: [],
      conflictCount: 0,
    };
  }
  if (globalReason) {
    const cohorts = allAdditions.map((addition) => ({
      publicationItemId: addition.publicationItemId,
      sku: addition.sku,
      productLine: addition.productLine,
      productName: addition.productName,
      quantity: addition.quantity,
      publishingAt: addition.publishingAt,
      confirmedAt: addition.confirmedAt,
      dateProvenance: addition.confirmedAt ? "recorded_confirmation" as const : "unknown" as const,
      attributionProvenance: "unsupported" as const,
      estimatedSoldQuantity: null,
      estimatedRemainingAtCutoff: null,
      reasons: [globalReason],
      allocations: [],
      forecastEvidence: addition.forecastEvidence,
      forecastEvidenceProvenance: addition.forecastEvidenceProvenance,
    }));
    return {
      status: "unavailable",
      reason: globalReason,
      cutoffAt: evidence.cutoffAt,
      summary: emptySummary(allAdditions),
      cohorts: cohorts.slice(0, DETAIL_LIMIT),
      cohortCount: cohorts.length,
      conflicts: [],
      conflictCount: 0,
    };
  }

  const reasonsByItem = new Map(allAdditions.map((addition) => [
    addition.publicationItemId,
    publicationReasons(addition, cutoffTime!, coverageStartTime!),
  ]));
  const itemsByDeltaKey = new Map<string, number[]>();
  for (const addition of allAdditions) {
    if (!addition.inventoryDeltaKey) continue;
    const itemIds = itemsByDeltaKey.get(addition.inventoryDeltaKey) ?? [];
    itemIds.push(addition.publicationItemId);
    itemsByDeltaKey.set(addition.inventoryDeltaKey, itemIds);
  }
  for (const itemIds of itemsByDeltaKey.values()) {
    if (itemIds.length < 2) continue;
    for (const itemId of itemIds) {
      reasonsByItem.set(itemId, unique([...(reasonsByItem.get(itemId) ?? []), "publication_evidence_invalid"]));
    }
  }
  const additionsBySku = new Map<number, HistoricalPublicationAdditionEvidence[]>();
  for (const addition of allAdditions) {
    const rows = additionsBySku.get(addition.sku) ?? [];
    rows.push(addition);
    additionsBySku.set(addition.sku, rows);
  }
  const firstPublicationBySku = new Map([...additionsBySku].map(([sku, rows]) => [
    sku,
    Math.min(...rows.map((row) => validTime(row.confirmedAt) ?? Number.POSITIVE_INFINITY)),
  ]));
  const { demands, conflicts: orderConflicts } = orderDemands(
    evidence.orderRevisions,
    firstPublicationBySku,
    cutoffTime!,
    evidence.validatedAt!,
  );
  const opening = new Map(evidence.openingQuantities.map((row) => [row.sku, row.quantity]));
  const results = new Map<number, {
    sold: number;
    remaining: number;
    allocations: HistoricalPublicationEstimateAllocation[];
  }>();
  const conflicts = new Map<number, {
    reasons: HistoricalPublicationEstimateReason[];
    difference: number | null;
  }>();
  let reconstructedOlderQuantity = 0;
  let reconstructedOlderRemainingAtCutoff = 0;

  for (const [sku, additions] of additionsBySku) {
    const staticReasons = unique(additions.flatMap((addition) => reasonsByItem.get(addition.publicationItemId) ?? []));
    const skuReasons = unique([...staticReasons, ...(orderConflicts.get(sku) ?? [])]);
    if (skuReasons.length > 0) {
      conflicts.set(sku, { reasons: skuReasons, difference: null });
      continue;
    }
    const firstConfirmed = Math.min(...additions.map((addition) => Date.parse(addition.confirmedAt!)));
    const skuDemands = (demands.get(sku) ?? []).filter((demand) =>
      Date.parse(demand.orderedAt) >= firstConfirmed && Date.parse(demand.orderedAt) < cutoffTime!);
    if (skuDemands.some((demand) => additions.some((addition) => addition.confirmedAt === demand.orderedAt))) {
      skuReasons.push("event_time_tie");
    }
    const additionQuantity = additions.reduce((sum, row) => sum + row.quantity, 0);
    const demandQuantity = skuDemands.reduce((sum, row) => sum + row.quantity, 0);
    const olderQuantity = (opening.get(sku) ?? 0) + demandQuantity - additionQuantity;
    if (olderQuantity < 0) skuReasons.push("quantity_conflict");
    if (skuReasons.length > 0) {
      conflicts.set(sku, { reasons: unique(skuReasons), difference: olderQuantity });
      continue;
    }

    const lots: MutableLot[] = olderQuantity > 0
      ? [{ addition: null, remaining: olderQuantity }]
      : [];
    const events = [
      ...additions.map((addition) => ({ time: Date.parse(addition.confirmedAt!), kind: "addition" as const, addition })),
      ...skuDemands.map((demand) => ({ time: Date.parse(demand.orderedAt), kind: "demand" as const, demand })),
    ].sort((left, right) => left.time - right.time ||
      (left.kind === right.kind
        ? left.kind === "addition"
          ? left.addition.publicationItemId - (right as typeof left).addition.publicationItemId
          : left.demand.orderNumber.localeCompare((right as typeof left).demand.orderNumber) ||
            left.demand.orderId.localeCompare((right as typeof left).demand.orderId)
        : left.kind === "addition" ? -1 : 1));
    let olderRemaining = olderQuantity;
    let underflow = false;
    for (const event of events) {
      if (event.kind === "addition") {
        lots.push({ addition: event.addition, remaining: event.addition.quantity });
        results.set(event.addition.publicationItemId, { sold: 0, remaining: event.addition.quantity, allocations: [] });
        continue;
      }
      let needed = event.demand.quantity;
      for (const lot of lots) {
        if (needed === 0) break;
        const quantity = Math.min(lot.remaining, needed);
        if (quantity === 0) continue;
        lot.remaining -= quantity;
        needed -= quantity;
        if (!lot.addition) {
          olderRemaining -= quantity;
          continue;
        }
        const result = results.get(lot.addition.publicationItemId)!;
        const confirmedAt = Date.parse(lot.addition.confirmedAt!);
        const publishingAt = validTime(lot.addition.publishingAt);
        result.sold += quantity;
        result.remaining -= quantity;
        result.allocations.push({
          orderId: event.demand.orderId,
          orderNumber: event.demand.orderNumber,
          orderedAt: event.demand.orderedAt,
          quantity,
          listedDaysLowerBound: Math.max(0, (event.time - confirmedAt) / DAY_MS),
          listedDaysUpperBound: publishingAt === null
            ? null
            : Math.max(0, (event.time - publishingAt) / DAY_MS),
        });
      }
      if (needed > 0) {
        underflow = true;
        break;
      }
    }
    if (underflow) {
      additions.forEach((addition) => results.delete(addition.publicationItemId));
      conflicts.set(sku, { reasons: ["temporal_underflow"], difference: olderQuantity });
      continue;
    }
    reconstructedOlderQuantity += olderQuantity;
    reconstructedOlderRemainingAtCutoff += olderRemaining;
  }

  const cohorts = allAdditions.map((addition) => {
    const result = results.get(addition.publicationItemId);
    const conflict = conflicts.get(addition.sku);
    return {
      publicationItemId: addition.publicationItemId,
      sku: addition.sku,
      productLine: addition.productLine,
      productName: addition.productName,
      quantity: addition.quantity,
      publishingAt: addition.publishingAt,
      confirmedAt: addition.confirmedAt,
      dateProvenance: addition.confirmedAt ? "recorded_confirmation" as const : "unknown" as const,
      attributionProvenance: result ? "estimated_closed_flow" as const : "unsupported" as const,
      estimatedSoldQuantity: result?.sold ?? null,
      estimatedRemainingAtCutoff: result?.remaining ?? null,
      reasons: result ? [] : conflict?.reasons ?? reasonsByItem.get(addition.publicationItemId) ?? ["publication_evidence_invalid"],
      allocations: result?.allocations ?? [],
      forecastEvidence: addition.forecastEvidence,
      forecastEvidenceProvenance: addition.forecastEvidenceProvenance,
    };
  });
  const estimated = cohorts.filter((row) => row.attributionProvenance === "estimated_closed_flow");
  const unsupported = cohorts.filter((row) => row.attributionProvenance === "unsupported");
  const conflictRows = [...conflicts].sort(([left], [right]) => left - right).map(([sku, conflict]) => ({
    sku,
    reasons: conflict.reasons,
    quantityDifference: conflict.difference,
  }));
  return {
    status: "ready",
    cutoffAt: evidence.cutoffAt,
    summary: {
      publicationItemCount: cohorts.length,
      publicationQuantity: cohorts.reduce((sum, row) => sum + row.quantity, 0),
      confirmedAdditionCount: cohorts.filter((row) => row.dateProvenance === "recorded_confirmation").length,
      confirmedAdditionQuantity: cohorts.filter((row) => row.dateProvenance === "recorded_confirmation")
        .reduce((sum, row) => sum + row.quantity, 0),
      estimatedAdditionCount: estimated.length,
      estimatedAdditionQuantity: estimated.reduce((sum, row) => sum + row.quantity, 0),
      unsupportedAdditionCount: unsupported.length,
      unsupportedAdditionQuantity: unsupported.reduce((sum, row) => sum + row.quantity, 0),
      estimatedSoldQuantity: estimated.reduce((sum, row) => sum + (row.estimatedSoldQuantity ?? 0), 0),
      estimatedRemainingAtCutoff: estimated.reduce((sum, row) => sum + (row.estimatedRemainingAtCutoff ?? 0), 0),
      reconstructedOlderQuantity,
      reconstructedOlderRemainingAtCutoff,
      supportedSkuCount: new Set(estimated.map((row) => row.sku)).size,
      conflictedSkuCount: conflicts.size,
    },
    cohorts: cohorts.slice(0, DETAIL_LIMIT),
    cohortCount: cohorts.length,
    conflicts: conflictRows.slice(0, DETAIL_LIMIT),
    conflictCount: conflictRows.length,
  };
}
