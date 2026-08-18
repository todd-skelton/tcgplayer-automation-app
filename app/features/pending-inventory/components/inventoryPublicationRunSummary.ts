import type { InventoryPublication } from "~/features/inventory-publication/types/inventoryPublication";

const ACTIVE_STATUSES = new Set<InventoryPublication["status"]>([
  "planned",
  "staging",
  "staged",
  "publishing",
]);

export interface InventoryPublicationRunSummary {
  status: "in_progress" | "published" | "failed" | "ambiguous";
  publicationCount: number;
  publishedCount: number;
  failedCount: number;
  ambiguousCount: number;
}

export function summarizeLatestInventoryPublicationRun(
  publications: readonly InventoryPublication[],
): InventoryPublicationRunSummary | null {
  const latestPublication = publications[0];
  if (!latestPublication) {
    return null;
  }

  const runPublications = publications.filter((publication) =>
    latestPublication.pricingJobId === null
      ? publication.id === latestPublication.id
      : publication.pricingJobId === latestPublication.pricingJobId,
  );
  const items = runPublications.flatMap((publication) => publication.items);
  const publishedCount = items.filter(
    (item) => item.status === "published",
  ).length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const ambiguousCount = items.filter(
    (item) => item.status === "ambiguous",
  ).length;

  let status: InventoryPublicationRunSummary["status"];
  if (
    runPublications.some((publication) =>
      ACTIVE_STATUSES.has(publication.status),
    )
  ) {
    status = "in_progress";
  } else if (
    failedCount > 0 ||
    runPublications.some(
      (publication) =>
        publication.status === "failed" || publication.status === "rolled_back",
    )
  ) {
    status = "failed";
  } else if (
    ambiguousCount > 0 ||
    runPublications.some((publication) => publication.status === "ambiguous")
  ) {
    status = "ambiguous";
  } else {
    status = "published";
  }

  return {
    status,
    publicationCount: runPublications.length,
    publishedCount,
    failedCount,
    ambiguousCount,
  };
}
