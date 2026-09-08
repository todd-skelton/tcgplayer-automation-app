import {
  SELL_THROUGH_HORIZONS,
  type InventorySellingHistoryReport,
  type SellingHistoryEpisodeDetail,
  type SellingHistoryEpisodeEvidence,
  type SellingHistoryOutcomeEvidence,
  type SellingHistoryProductLine,
  type SellingHistorySourceEvidence,
  type SellingHistorySummary,
} from "../types/inventorySellingHistory";

const DAY_MS = 86_400_000;
const DETAIL_LIMIT = 50;

type PreparedEpisode = SellingHistoryEpisodeEvidence & {
  listedTime: number | null;
  outcomes: SellingHistoryOutcomeEvidence[];
};

function daysBetween(start: number, end: number): number {
  return Math.max(0, (end - start) / DAY_MS);
}

function reachedPercentile(
  observations: Array<{ days: number; quantity: number; sold: boolean }>,
  targetSurvival: number,
): number | null {
  let atRisk = observations.reduce((sum, row) => sum + row.quantity, 0);
  let survival = 1;
  const sorted = [...observations].sort((left, right) => left.days - right.days);
  for (let index = 0; index < sorted.length; ) {
    const days = sorted[index].days;
    const rows: typeof sorted = [];
    while (index < sorted.length && sorted[index].days === days) {
      rows.push(sorted[index]);
      index += 1;
    }
    const sold = rows
      .filter((row) => row.sold)
      .reduce((sum, row) => sum + row.quantity, 0);
    if (sold > 0 && atRisk > 0) survival *= 1 - sold / atRisk;
    if (survival <= targetSurvival) return days;
    atRisk -= rows.reduce((sum, row) => sum + row.quantity, 0);
  }
  return null;
}

function prepareEpisodes(
  episodes: SellingHistoryEpisodeEvidence[],
  outcomes: SellingHistoryOutcomeEvidence[],
  asOfTime: number,
): PreparedEpisode[] {
  const outcomesByEpisode = new Map<string, SellingHistoryOutcomeEvidence[]>();
  for (const outcome of outcomes) {
    if (Date.parse(outcome.happenedAt) > asOfTime) continue;
    const rows = outcomesByEpisode.get(outcome.episodeKey) ?? [];
    rows.push(outcome);
    outcomesByEpisode.set(outcome.episodeKey, rows);
  }
  return episodes
    .filter(
      (episode) =>
        episode.listedAt === null || Date.parse(episode.listedAt) <= asOfTime,
    )
    .map((episode) => {
    const episodeOutcomes = outcomesByEpisode.get(episode.episodeKey) ?? [];
    const used = episodeOutcomes.reduce((sum, row) => sum + row.quantity, 0);
    if (used > episode.quantity) {
      throw new Error(
        "Selling history episode " + episode.episodeKey + " uses more units than its cohort.",
      );
    }
    return {
      ...episode,
      listedTime: episode.listedAt ? Date.parse(episode.listedAt) : null,
      outcomes: episodeOutcomes,
    };
    });
}

function summarize(
  episodes: PreparedEpisode[],
  asOfTime: number,
  uncertainSkus: Set<number>,
  unsettledSkus: Set<number>,
  hasUnresolvedRemoval: boolean,
): SellingHistorySummary {
  const cohortQuantity = episodes.reduce((sum, row) => sum + row.quantity, 0);
  const known = episodes.filter((row) => row.listedTime !== null);
  const knownListedDateQuantity = known.reduce(
    (sum, row) => sum + row.quantity,
    0,
  );
  const sales = episodes.flatMap((episode) =>
    episode.outcomes
      .filter((outcome) => outcome.kind === "sale")
      .map((outcome) => ({ episode, outcome })),
  );
  const knownSales = sales.filter(({ episode }) => episode.listedTime !== null);
  const removedQuantity = episodes.reduce(
    (sum, episode) =>
      sum +
      episode.outcomes
        .filter((outcome) => outcome.kind === "removed")
        .reduce((subtotal, outcome) => subtotal + outcome.quantity, 0),
    0,
  );
  const remaining = episodes.map((episode) => ({
    episode,
    quantity:
      episode.quantity -
      episode.outcomes.reduce((sum, outcome) => sum + outcome.quantity, 0),
  }));
  const knownRemaining = remaining.filter(
    ({ episode, quantity }) => episode.listedTime !== null && quantity > 0,
  );
  const remainingWithUncertainPresenceQuantity = knownRemaining
    .filter(({ episode }) => uncertainSkus.has(episode.sku))
    .reduce((sum, row) => sum + row.quantity, 0);
  const remainingWithKnownAgeQuantity = knownRemaining
    .filter(({ episode }) => !uncertainSkus.has(episode.sku))
    .reduce((sum, row) => sum + row.quantity, 0);
  const soldDays = knownSales.map(({ episode, outcome }) => ({
    days: daysBetween(episode.listedTime!, Date.parse(outcome.happenedAt)),
    quantity: outcome.quantity,
  }));
  const soldWithKnownListedDateQuantity = soldDays.reduce(
    (sum, row) => sum + row.quantity,
    0,
  );
  const soldOnlyAverageDays = soldWithKnownListedDateQuantity
    ? soldDays.reduce((sum, row) => sum + row.days * row.quantity, 0) /
      soldWithKnownListedDateQuantity
    : null;
  const competingRemovals = removedQuantity > 0 || hasUnresolvedRemoval;
  const unsettledOutcomes = known.some((episode) => unsettledSkus.has(episode.sku));
  const percentileUnavailable = competingRemovals || unsettledOutcomes;
  const survivalObservations = percentileUnavailable
    ? []
    : [
        ...soldDays.map((row) => ({ ...row, sold: true })),
        ...knownRemaining.map(({ episode, quantity }) => ({
          days: daysBetween(episode.listedTime!, asOfTime),
          quantity,
          sold: false,
        })),
      ];
  const medianDaysToSale = percentileUnavailable
    ? null
    : reachedPercentile(survivalObservations, 0.5);
  const p90DaysToSale = percentileUnavailable
    ? null
    : reachedPercentile(survivalObservations, 0.1);

  return {
    cohortQuantity,
    knownListedDateQuantity,
    unknownListedDateQuantity: cohortQuantity - knownListedDateQuantity,
    soldQuantity: sales.reduce((sum, row) => sum + row.outcome.quantity, 0),
    soldWithKnownListedDateQuantity,
    remainingWithKnownAgeQuantity,
    remainingWithUncertainPresenceQuantity,
    removedQuantity,
    soldOnlyAverageDays,
    medianDaysToSale,
    p90DaysToSale,
    percentileStatus: unsettledOutcomes
      ? "unsettled_outcomes"
      : competingRemovals
      ? "competing_removals"
      : medianDaysToSale !== null || p90DaysToSale !== null
        ? "estimable"
        : "not_reached",
    sellThrough: SELL_THROUGH_HORIZONS.map((days) => {
      const eligible = known.filter(
        (episode) => daysBetween(episode.listedTime!, asOfTime) >= days,
      );
      const eligibleQuantity = eligible.reduce(
        (sum, episode) => sum + episode.quantity,
        0,
      );
      const soldQuantity = eligible.reduce(
        (sum, episode) =>
          sum +
          episode.outcomes
            .filter(
              (outcome) =>
                outcome.kind === "sale" &&
                daysBetween(
                  episode.listedTime!,
                  Date.parse(outcome.happenedAt),
                ) <= days,
            )
            .reduce((subtotal, outcome) => subtotal + outcome.quantity, 0),
        0,
      );
      const unsettled = eligible.some((episode) => unsettledSkus.has(episode.sku));
      return {
        days,
        eligibleQuantity,
        soldQuantity,
        rate: eligibleQuantity && !unsettled ? soldQuantity / eligibleQuantity : null,
        status: unsettled ? "unsettled_outcomes" : "exact",
      };
    }),
  };
}

function episodeDetail(
  episode: PreparedEpisode,
  asOfTime: number,
  uncertainSkus: Set<number>,
): SellingHistoryEpisodeDetail {
  const sold = episode.outcomes.filter((row) => row.kind === "sale");
  const removed = episode.outcomes.filter((row) => row.kind === "removed");
  const used = episode.outcomes.reduce((sum, row) => sum + row.quantity, 0);
  const ledgerRemainingQuantity = episode.quantity - used;
  return {
    episodeKey: episode.episodeKey,
    receiptId: episode.receiptId,
    sku: episode.sku,
    productLine: episode.productLine,
    productName: episode.productName,
    kind: episode.kind,
    quantity: episode.quantity,
    listedAt: episode.listedAt,
    soldQuantity: sold.reduce((sum, row) => sum + row.quantity, 0),
    removedQuantity: removed.reduce((sum, row) => sum + row.quantity, 0),
    ledgerRemainingQuantity,
    remainingAgeDays:
      ledgerRemainingQuantity > 0 && episode.listedTime !== null
        ? daysBetween(episode.listedTime, asOfTime)
        : null,
    presenceUncertain: uncertainSkus.has(episode.sku),
    forecastEvidenceProvenance: episode.forecastEvidenceProvenance,
    forecastEvidence: episode.forecastEvidence,
    orders: sold
      .filter((row) => row.orderNumber)
      .map((row) => ({
        orderNumber: row.orderNumber!,
        quantity: row.quantity,
        soldAt: row.happenedAt,
        listedDays:
          episode.listedTime === null
            ? null
            : daysBetween(episode.listedTime, Date.parse(row.happenedAt)),
      })),
  };
}

export function buildInventorySellingHistoryReport(
  evidence: SellingHistorySourceEvidence,
  detailPage = 1,
): InventorySellingHistoryReport {
  const unavailable = (
    reason: Extract<
      InventorySellingHistoryReport,
      { status: "unavailable" }
    >["reason"],
  ): InventorySellingHistoryReport => ({
    status: "unavailable",
    sellerKey: evidence.sellerKey,
    scope: evidence.scope,
    availableProductLines: evidence.availableProductLines,
    reason,
    orderCoverage: evidence.orderCoverage,
  });
  if (evidence.orderCoverage.sellerKey !== evidence.sellerKey)
    return unavailable("seller_not_configured");
  if (
    evidence.orderCoverage.status !== "complete" ||
    evidence.orderCoverage.gaps.length > 0 ||
    !evidence.orderCoverage.completedAt
  )
    return unavailable("order_coverage_incomplete");
  if (
    evidence.episodeCount > evidence.episodes.length ||
    evidence.outcomeCount > evidence.outcomes.length
  )
    return unavailable("history_bounds_exceeded");

  const asOfTime = Date.parse(evidence.orderCoverage.completedAt);
  const prepared = prepareEpisodes(evidence.episodes, evidence.outcomes, asOfTime);
  const observedAt = evidence.inventoryObservedAt
    ? Date.parse(evidence.inventoryObservedAt)
    : null;
  const uncertainSkus = new Set([
    ...evidence.projection.affectedSkus,
    ...evidence.unresolvedRemoval.affectedSkus,
    ...(observedAt === null || observedAt < asOfTime
      ? prepared.map((episode) => episode.sku)
      : []),
  ]);
  const grouped = new Map<string, PreparedEpisode[]>();
  for (const episode of prepared) {
    const productLineEpisodes = grouped.get(episode.productLine);
    if (productLineEpisodes) productLineEpisodes.push(episode);
    else grouped.set(episode.productLine, [episode]);
  }
  const productLines: SellingHistoryProductLine[] = [...grouped.entries()]
    .map(([productLine, rows]) => ({
      productLine,
      ...summarize(
        rows,
        asOfTime,
        uncertainSkus,
        new Set(rows.filter((row) => evidence.projection.affectedSkus.includes(row.sku)).map((row) => row.sku)),
        evidence.unresolvedRemoval.affectedSkus.some((sku) =>
          rows.some((row) => row.sku === sku),
        ),
      ),
    }))
    .sort((left, right) => right.cohortQuantity - left.cohortQuantity);
  const details = prepared
    .map((episode) => episodeDetail(episode, asOfTime, uncertainSkus))
    .sort((left, right) => {
      if (left.listedAt === null) return 1;
      if (right.listedAt === null) return -1;
      return right.listedAt.localeCompare(left.listedAt);
    });
  const detailPageCount = Math.max(1, Math.ceil(details.length / DETAIL_LIMIT));
  const selectedDetailPage = Math.min(
    detailPageCount,
    Math.max(1, Math.trunc(detailPage)),
  );
  const detailOffset = (selectedDetailPage - 1) * DETAIL_LIMIT;

  return {
    status: "ready",
    sellerKey: evidence.sellerKey,
    scope: evidence.scope,
    availableProductLines: evidence.availableProductLines,
    analysisFrom: evidence.analysisFrom,
    asOf: new Date(asOfTime).toISOString(),
    orderCoverage: evidence.orderCoverage,
    overall: summarize(
      prepared,
      asOfTime,
      uncertainSkus,
      new Set(evidence.projection.affectedSkus),
      evidence.unresolvedRemoval.quantity > 0,
    ),
    productLines,
    details: details.slice(detailOffset, detailOffset + DETAIL_LIMIT),
    detailTotal: details.length,
    detailPage: selectedDetailPage,
    detailPageCount,
    coverage: {
      pendingProjectionQuantity: evidence.projection.pendingQuantity,
      heldProjectionQuantity: evidence.projection.heldQuantity,
      unresolvedRemovalQuantity: evidence.unresolvedRemoval.quantity,
      affectedRemovalSkus: evidence.unresolvedRemoval.affectedSkus.length,
      openingUnknownQuantity: evidence.openingUnknownQuantity,
      legacyUnlinkedQuantity: evidence.legacyUnlinked.quantity,
      legacyUnlinkedForecastQuantity: evidence.legacyUnlinked.forecastQuantity,
      olderPublicationQuantity: evidence.olderPublicationQuantity,
      awaitingCutoffQuantity: evidence.awaitingCutoffQuantity,
    },
  };
}
