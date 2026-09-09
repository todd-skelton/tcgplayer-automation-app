import assert from "node:assert/strict";
import type {
  HistoricalOrderRevisionEvidence,
  HistoricalPublicationAdditionEvidence,
  HistoricalPublicationEstimateEvidence,
} from "../types/inventorySellingHistory";
import { estimateHistoricalPublicationHistory } from "./historicalPublicationEstimate";

const day = (value: number) => new Date(Date.UTC(2026, 0, value)).toISOString();

function addition(
  publicationItemId: number,
  sku: number,
  quantity: number,
  confirmedDay: number,
): HistoricalPublicationAdditionEvidence {
  return {
    publicationItemId,
    sku,
    productLine: "Pokemon",
    productName: `Card ${sku}`,
    quantity,
    sourceType: "pending_inventory",
    method: "staged_delta",
    inventoryDeltaKey: `batch:${publicationItemId}:${sku}`,
    batchItemCount: 1,
    batchAddToQuantity: quantity,
    skuProductLineCount: 1,
    publishingAt: new Date(Date.parse(day(confirmedDay)) - 60_000).toISOString(),
    confirmedAt: day(confirmedDay),
    forecastEvidence: null,
    forecastEvidenceProvenance: "unknown",
  };
}

function revision(
  orderId: string,
  orderDay: number,
  lines: Array<{ skuId: string; quantity: number }>,
  revisionNumber = 1,
  lifecycle = "completed_paid",
  observedDay = 19,
): HistoricalOrderRevisionEvidence {
  return {
    orderId,
    orderNumber: `ORDER-${orderId}`,
    revisionNumber,
    observedAt: day(observedDay),
    orderTime: day(orderDay),
    orderTimeEvidence: "detail_canonical",
    lifecycle,
    lines,
  };
}

function evidence(
  additions: HistoricalPublicationAdditionEvidence[],
  openingQuantities: Array<{ sku: number; quantity: number }>,
  orderRevisions: HistoricalOrderRevisionEvidence[] = [],
): HistoricalPublicationEstimateEvidence {
  return {
    sourceAvailable: true,
    cutoffAt: day(20),
    coverageStartsAt: day(-60),
    coverageComplete: true,
    validatedAt: day(20),
    additions,
    additionCount: additions.length,
    openingQuantities,
    orderRevisions,
    orderRevisionCount: orderRevisions.length,
  };
}

const split = estimateHistoricalPublicationHistory(evidence(
  [addition(1, 10, 3, 2), addition(2, 10, 2, 6)],
  [{ sku: 10, quantity: 1 }],
  [revision("1", 10, [{ skuId: "10", quantity: 4 }])],
));
assert.equal(split.status, "ready");
assert.deepEqual(split.summary, {
  publicationItemCount: 2,
  publicationQuantity: 5,
  confirmedAdditionCount: 2,
  confirmedAdditionQuantity: 5,
  estimatedAdditionCount: 2,
  estimatedAdditionQuantity: 5,
  unsupportedAdditionCount: 0,
  unsupportedAdditionQuantity: 0,
  estimatedSoldQuantity: 4,
  estimatedRemainingAtCutoff: 1,
  reconstructedOlderQuantity: 0,
  reconstructedOlderRemainingAtCutoff: 0,
  supportedSkuCount: 1,
  conflictedSkuCount: 0,
});
assert.deepEqual(split.cohorts.map((row) => [
  row.publicationItemId,
  row.estimatedSoldQuantity,
  row.estimatedRemainingAtCutoff,
  row.attributionProvenance,
]), [
  [1, 3, 0, "estimated_closed_flow"],
  [2, 1, 1, "estimated_closed_flow"],
]);
assert.equal(split.cohorts[1].allocations[0].listedDaysLowerBound, 4);
assert.ok((split.cohorts[1].allocations[0].listedDaysUpperBound ?? 0) > 4);

const older = estimateHistoricalPublicationHistory(evidence(
  [addition(3, 20, 3, 2)],
  [{ sku: 20, quantity: 5 }],
  [revision("2", 3, [{ skuId: "20", quantity: 1 }])],
));
assert.equal(older.summary.reconstructedOlderQuantity, 3);
assert.equal(older.summary.reconstructedOlderRemainingAtCutoff, 2);
assert.equal(older.cohorts[0].estimatedSoldQuantity, 0);
assert.equal(older.cohorts[0].estimatedRemainingAtCutoff, 3);

const negative = estimateHistoricalPublicationHistory(evidence(
  [addition(4, 30, 10, 2)],
  [{ sku: 30, quantity: 5 }],
  [revision("3", 3, [{ skuId: "30", quantity: 2 }])],
));
assert.equal(negative.cohorts[0].attributionProvenance, "unsupported");
assert.deepEqual(negative.cohorts[0].reasons, ["quantity_conflict"]);
assert.equal(negative.conflicts[0].quantityDifference, -3);

const temporal = estimateHistoricalPublicationHistory(evidence(
  [addition(5, 40, 2, 2), addition(6, 40, 5, 6)],
  [{ sku: 40, quantity: 3 }],
  [revision("4", 4, [{ skuId: "40", quantity: 4 }])],
));
assert.equal(temporal.summary.unsupportedAdditionQuantity, 7);
assert.deepEqual(temporal.conflicts[0].reasons, ["temporal_underflow"]);

const financialOnlyRevision = estimateHistoricalPublicationHistory(evidence(
  [addition(7, 50, 2, 2)],
  [{ sku: 50, quantity: 1 }],
  [
    revision("5", 3, [{ skuId: "50", quantity: 1 }], 1, "processing", 19),
    revision("5", 3, [{ skuId: "50", quantity: 1 }], 2, "completed_paid", 21),
  ],
));
assert.equal(financialOnlyRevision.summary.estimatedAdditionQuantity, 2);

const canceled = estimateHistoricalPublicationHistory(evidence(
  [addition(8, 60, 2, 2)],
  [{ sku: 60, quantity: 2 }],
  [revision("6", 3, [{ skuId: "60", quantity: 1 }], 1, "canceled")],
));
assert.deepEqual(canceled.conflicts[0].reasons, ["order_lifecycle_unsettled"]);

const moved = estimateHistoricalPublicationHistory(evidence(
  [addition(9, 70, 1, 2), addition(10, 71, 1, 2)],
  [{ sku: 70, quantity: 1 }, { sku: 71, quantity: 1 }],
  [
    revision("7", 3, [{ skuId: "70", quantity: 1 }], 1, "completed_paid", 19),
    revision("7", 3, [{ skuId: "71", quantity: 1 }], 2, "completed_paid", 21),
  ],
));
assert.deepEqual(moved.conflicts.map((row) => [row.sku, row.reasons]), [
  [70, ["order_history_changed"]],
  [71, ["order_history_changed"]],
]);

const priorCanceled = estimateHistoricalPublicationHistory(evidence(
  [addition(14, 100, 3, 5)],
  [{ sku: 100, quantity: 3 }],
  [revision("8", 1, [{ skuId: "100", quantity: 1 }], 1, "canceled")],
));
assert.equal(priorCanceled.summary.estimatedAdditionQuantity, 3);
assert.equal(priorCanceled.cohorts[0].estimatedRemainingAtCutoff, 3);

const repricing = addition(11, 80, 1, 2);
repricing.quantity = 0;
repricing.batchAddToQuantity = 0;
const invalid = estimateHistoricalPublicationHistory(evidence(
  [repricing, { ...addition(12, 81, 1, 2), batchAddToQuantity: 2 }],
  [{ sku: 80, quantity: 0 }, { sku: 81, quantity: 1 }],
));
assert.equal(invalid.summary.estimatedAdditionQuantity, 0);
assert.ok(invalid.cohorts.every((row) => row.reasons.includes("publication_evidence_invalid")));

const incomplete = estimateHistoricalPublicationHistory({
  ...evidence([addition(13, 90, 1, 2)], [{ sku: 90, quantity: 1 }]),
  orderRevisionCount: 1,
});
assert.equal(incomplete.status, "unavailable");
assert.equal(incomplete.reason, "source_bounds_exceeded");

const sourceFailure = estimateHistoricalPublicationHistory({
  ...evidence([], []),
  sourceAvailable: false,
});
assert.equal(sourceFailure.status, "unavailable");
assert.equal(sourceFailure.reason, "source_read_failed");

const unconfirmedAddition = { ...addition(15, 110, 1, 2), confirmedAt: null };
const unconfirmed = estimateHistoricalPublicationHistory(evidence(
  [unconfirmedAddition],
  [],
));
assert.equal(unconfirmed.status, "ready");
assert.equal(unconfirmed.summary.publicationItemCount, 1);
assert.equal(unconfirmed.summary.confirmedAdditionCount, 0);
assert.equal(unconfirmed.cohorts[0].dateProvenance, "unknown");
assert.deepEqual(unconfirmed.cohorts[0].reasons, ["publication_evidence_invalid"]);

const duplicateA = addition(16, 120, 1, 2);
const duplicateB = { ...addition(17, 121, 1, 2), inventoryDeltaKey: duplicateA.inventoryDeltaKey };
const duplicateIdentity = estimateHistoricalPublicationHistory(evidence(
  [duplicateA, duplicateB],
  [],
));
assert.equal(duplicateIdentity.summary.unsupportedAdditionQuantity, 2);
assert.ok(duplicateIdentity.cohorts.every((row) => row.reasons.includes("publication_evidence_invalid")));

const absentOpeningMeansZero = estimateHistoricalPublicationHistory(evidence(
  [addition(18, 130, 1, 2)],
  [],
  [revision("9", 3, [{ skuId: "130", quantity: 1 }])],
));
assert.equal(absentOpeningMeansZero.summary.estimatedAdditionQuantity, 1);
assert.equal(absentOpeningMeansZero.cohorts[0].estimatedRemainingAtCutoff, 0);

const earlyLot = addition(19, 140, 1, 2);
const lateLot = addition(20, 140, 1, 3);
const zOrder = revision("10", 4, [{ skuId: "140", quantity: 1 }]);
zOrder.orderNumber = "Z-ORDER";
const aOrder = revision("20", 4, [{ skuId: "140", quantity: 1 }]);
aOrder.orderNumber = "A-ORDER";
const equalTime = evidence([earlyLot, lateLot], [], [zOrder, aOrder]);
const equalTimeEstimate = estimateHistoricalPublicationHistory(equalTime);
assert.equal(equalTimeEstimate.cohorts[0].allocations[0].orderNumber, "A-ORDER");
assert.deepEqual(
  estimateHistoricalPublicationHistory(equalTime),
  equalTimeEstimate,
  "equal-time order replay is deterministic",
);

const publicationOrderTie = estimateHistoricalPublicationHistory(evidence(
  [addition(21, 150, 1, 2)],
  [],
  [revision("21", 2, [{ skuId: "150", quantity: 1 }])],
));
assert.deepEqual(publicationOrderTie.conflicts[0].reasons, ["event_time_tie"]);

const crossLinePokemon = { ...addition(22, 160, 1, 2), productLine:"Pokemon", skuProductLineCount:2 };
const crossLineMagic = { ...addition(23, 160, 1, 3), productLine:"Magic", skuProductLineCount:2 };
const crossLineAll = estimateHistoricalPublicationHistory(evidence(
  [crossLinePokemon, crossLineMagic],
  [],
));
assert.ok(crossLineAll.cohorts.every((row) =>
  row.reasons.includes("publication_identity_conflict")));
const crossLineScoped = estimateHistoricalPublicationHistory(evidence(
  [crossLinePokemon],
  [],
));
assert.deepEqual(crossLineScoped.cohorts[0].reasons, ["publication_identity_conflict"]);
assert.equal(crossLineScoped.summary.reconstructedOlderQuantity, 0);

console.log("PASS historical publication estimates preserve facts and fail closed on ambiguous lineage");
