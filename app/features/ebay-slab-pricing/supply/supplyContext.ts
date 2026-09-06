import type { SupplyEvidence } from "../evidence/slabEvidence";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import { compareCompIdentity } from "../screening/compIdentity";
import { screenCompetitorSupply } from "../screening/screenComparables";

export type SupplyScan = {
  id: string;
  sourceKey: string;
  capturedAt: string;
  complete: boolean;
  reportedCount: number;
  listings: SupplyEvidence[];
};
export type SellerOutcome = {
  id: string;
  seller: string;
  itemId: string;
  occurredAt: string;
  observedAt: string;
  kind: "sale" | "cancellation" | "relist";
  nextItemId: string | null;
  relatedSaleId: string | null;
  quantity: number;
  price: { amount: number; currency: string } | null;
  source: "ebay-seller" | "reviewed-manual";
  note: string | null;
};
export const supplyListingKey = (listing: SupplyEvidence) =>
  `${listing.provider}:${listing.providerId}`;
const UNKNOWN_GRADING = {
  grader: "UNKNOWN",
  encoding: "unknown",
  number: null,
  label: null,
  qualifier: null,
  autograph: null,
};

export function describeSupply(
  scan: SupplyScan,
  target: StoredSlabIdentity,
  ownEbayItemIds: ReadonlySet<string>,
  now: string,
  invalidated = false,
) {
  const stale =
    invalidated ||
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(Date.parse(scan.capturedAt)) ||
    Date.parse(now) < Date.parse(scan.capturedAt) ||
    Date.parse(now) - Date.parse(scan.capturedAt) > 15 * 60 * 1000;
  const rows = scan.listings.map((listing) => {
    const gate = screenCompetitorSupply(listing, {
      ownEbayItemIds,
      capturedAt: scan.capturedAt,
      now,
      maxAgeMs: 15 * 60 * 1000,
    });
    const linkedAsset =
      listing.provider === "alt" &&
      !!target.identity?.providerAsset &&
      listing.assetId === target.identity.providerAsset.id &&
      listing.items.length === 1 &&
      listing.items[0].assetId === listing.assetId;
    const identityReasons =
      target.status === "confirmed" && target.identity
        ? compareCompIdentity(
            {
              card: linkedAsset ? target.identity.card : null,
              grading:
                listing.items.length === 1
                  ? listing.items[0].grading
                  : UNKNOWN_GRADING,
              title: listing.title ?? null,
              extendedTitle: listing.extendedTitle,
            },
            target.identity,
          )
        : [
            {
              code: "target-identity-unconfirmed",
              severity: "review" as const,
            },
          ];
    const reasons = [...gate.reasons, ...identityReasons.map((r) => r.code)];
    if (invalidated) reasons.push("supply-refresh-invalidated");
    if (listing.items.length > 1) reasons.push("bundle-not-a-single-slab");
    const excluded =
      invalidated ||
      gate.reasons.length > 0 ||
      listing.items.length > 1 ||
      identityReasons.some((r) => r.severity === "reject");
    const status = excluded
      ? ("excluded" as const)
      : identityReasons.length
        ? ("potential-match" as const)
        : ("equivalent" as const);
    const delivered =
      listing.priceKind === "ask" &&
      listing.price?.currency === "USD" &&
      Number.isFinite(listing.price.amount) &&
      listing.price.amount > 0 &&
      listing.shipping?.currency === "USD" &&
      Number.isFinite(listing.shipping.amount) &&
      listing.shipping.amount >= 0
        ? listing.price.amount + listing.shipping.amount
        : null;
    const age =
      listing.startedAt &&
      Number.isFinite(Date.parse(listing.startedAt)) &&
      Date.parse(listing.startedAt) <= Date.parse(scan.capturedAt)
        ? (Date.parse(scan.capturedAt) - Date.parse(listing.startedAt)) /
          86400000
        : null;
    return {
      key: supplyListingKey(listing),
      listing,
      status,
      reasons,
      deliveredAsk: delivered,
      listingAgeDays: age,
      seller: null,
    };
  });
  const equivalent = rows.filter((r) => r.status === "equivalent"),
    potential = rows.filter((r) => r.status === "potential-match");
  const minimum = (values: Array<number | null>) => {
    const known = values.filter((v): v is number => v !== null);
    return known.length ? Math.min(...known) : null;
  };
  return {
    capturedAt: scan.capturedAt,
    complete: scan.complete,
    reportedCount: scan.reportedCount,
    stale,
    rows,
    equivalentListings: equivalent.length,
    potentialListings: potential.length,
    excludedListings: rows.length - equivalent.length - potential.length,
    lowestEquivalentDeliveredAsk: minimum(
      equivalent.map((r) => r.deliveredAsk),
    ),
    lowestPotentialDeliveredAsk: minimum(potential.map((r) => r.deliveredAsk)),
    saleProbability: null,
    expectedDaysToSell: null,
    pricePolicyChanged: false as const,
  };
}
export function compareSupplyScans(previous: SupplyScan, current: SupplyScan) {
  if (
    previous.sourceKey !== current.sourceKey ||
    !Number.isFinite(Date.parse(previous.capturedAt)) ||
    !Number.isFinite(Date.parse(current.capturedAt)) ||
    Date.parse(previous.capturedAt) >= Date.parse(current.capturedAt)
  )
    throw new Error(
      "Compare consecutive observations of the same supply scope.",
    );
  const before = new Map(
    previous.listings.map((r) => [supplyListingKey(r), r]),
  );
  const after = new Map(current.listings.map((r) => [supplyListingKey(r), r]));
  return {
    observedFrom: previous.capturedAt,
    observedThrough: current.capturedAt,
    continuousExposureKnown: false as const,
    changes: [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .flatMap((key) => {
        const a = before.get(key),
          b = after.get(key);
        if (!a) return [{ key, kind: "newly-observed", saleConfirmed: false }];
        if (!b)
          return [
            {
              key,
              kind: current.complete
                ? "not-in-complete-scan"
                : "not-observed-in-partial-scan",
              saleConfirmed: false,
            },
          ];
        const changed =
          JSON.stringify([
            a.price?.amount,
            a.price?.currency,
            a.priceKind,
            a.shipping?.amount,
            a.shipping?.currency,
          ]) !==
          JSON.stringify([
            b.price?.amount,
            b.price?.currency,
            b.priceKind,
            b.shipping?.amount,
            b.shipping?.currency,
          ]);
        const items = (listing: SupplyEvidence) =>
          JSON.stringify(
            listing.items
              .map((item) =>
                JSON.stringify([
                  item.assetId,
                  item.grading.grader,
                  item.grading.number,
                  item.grading.label,
                  item.grading.encoding,
                  item.grading.qualifier,
                  item.grading.autograph,
                ]),
              )
              .sort(),
          );
        return [
          ...(changed
            ? [{ key, kind: "observed-price-change", saleConfirmed: false }]
            : []),
          ...(a.state !== b.state || a.format !== b.format
            ? [
                {
                  key,
                  kind: "observed-availability-change",
                  saleConfirmed: false,
                },
              ]
            : []),
          ...(a.quantity !== b.quantity
            ? [{ key, kind: "observed-quantity-change", saleConfirmed: false }]
            : []),
          ...(a.title !== b.title ||
          a.extendedTitle !== b.extendedTitle ||
          items(a) !== items(b)
            ? [{ key, kind: "observed-details-change", saleConfirmed: false }]
            : []),
        ];
      }),
  };
}
export function reconcileSellerOutcomes(
  outcomes: readonly SellerOutcome[],
  options: { seller: string; itemIds: ReadonlySet<string>; asOf: string },
) {
  if (outcomes.length > 10000 || !Number.isFinite(Date.parse(options.asOf)))
    throw new Error("Provide bounded seller outcomes and an evaluation time.");
  const events = new Map<string, SellerOutcome[]>();
  for (const row of outcomes) {
    if (
      Number.isFinite(Date.parse(row.observedAt)) &&
      Date.parse(row.observedAt) > Date.parse(options.asOf)
    )
      continue;
    const group = events.get(row.id) ?? [];
    group.push(row);
    events.set(row.id, group);
  }
  const known: SellerOutcome[] = [],
    unresolved: string[] = [];
  for (const [id, copies] of events) {
    const row = [...copies].sort((a, b) =>
      a.observedAt.localeCompare(b.observedAt),
    )[0];
    const signature = (value: SellerOutcome) =>
      JSON.stringify([
        value.seller,
        value.itemId,
        value.occurredAt,
        value.kind,
        value.nextItemId,
        value.relatedSaleId,
        value.quantity,
        value.price?.amount ?? null,
        value.price?.currency ?? null,
        value.source,
      ]);
    if (
      !id ||
      row.seller !== options.seller ||
      !options.itemIds.has(row.itemId) ||
      copies.some((copy) => signature(copy) !== signature(row)) ||
      !["sale", "cancellation", "relist"].includes(row.kind) ||
      !["ebay-seller", "reviewed-manual"].includes(row.source) ||
      !Number.isFinite(Date.parse(row.occurredAt)) ||
      !Number.isFinite(Date.parse(row.observedAt)) ||
      Date.parse(row.observedAt) > Date.parse(options.asOf) ||
      Date.parse(row.occurredAt) > Date.parse(row.observedAt) ||
      !Number.isInteger(row.quantity) ||
      row.quantity !== 1 ||
      (row.price !== null &&
        (!Number.isFinite(row.price.amount) ||
          row.price.amount <= 0 ||
          !/^[A-Z]{3}$/.test(row.price.currency))) ||
      (row.source === "reviewed-manual" && !row.note?.trim()) ||
      (row.kind === "relist" &&
        (!row.nextItemId || row.nextItemId === row.itemId))
    ) {
      unresolved.push(id);
      continue;
    }
    known.push(row);
  }
  const cancelled = new Set<string>();
  const salesById = new Map(
    known.filter((r) => r.kind === "sale").map((r) => [r.id, r]),
  );
  for (const event of known.filter(
    (r) => r.kind === "cancellation" && r.relatedSaleId,
  )) {
    const sale = salesById.get(event.relatedSaleId!);
    if (
      sale &&
      sale.itemId === event.itemId &&
      Date.parse(sale.occurredAt) <= Date.parse(event.occurredAt)
    )
      cancelled.add(sale.id);
    else unresolved.push(event.id);
  }
  return {
    known,
    unresolved,
    sales: known.filter((r) => r.kind === "sale" && !cancelled.has(r.id))
      .length,
    cancelledSaleIds: [...cancelled],
    cancellations: known.filter((r) => r.kind === "cancellation").length,
    relists: known.filter((r) => r.kind === "relist").length,
    exposureValidated: false as const,
    saleProbability: null,
    expectedDaysToSell: null,
  };
}
