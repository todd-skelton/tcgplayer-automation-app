import {
  inventoryPublicationsRepository,
  inventorySellingHistoryRepository,
} from "~/core/db";
import type { SellerOrderCoverage } from "~/features/seller-order-history/types/sellerOrderHistory";
import type {
  InventorySellingHistoryReport,
  SellingHistoryScope,
  SellingHistorySourceEvidence,
} from "../types/inventorySellingHistory";
import { DEFAULT_SELLING_HISTORY_SCOPE } from "../types/inventorySellingHistory";
import { buildInventorySellingHistoryReport } from "./inventorySellingHistory";

export interface InventorySellingHistorySource {
  backfillSupportedForecastEvidence(
    sellerKey: string,
    limit?: number,
  ): Promise<number>;
  findEvidence(
    sellerKey: string,
    scope: SellingHistoryScope,
  ): Promise<SellingHistorySourceEvidence>;
}

const source: InventorySellingHistorySource = {
  backfillSupportedForecastEvidence: (sellerKey, limit) =>
    inventoryPublicationsRepository.backfillSupportedForecastEvidence(
      sellerKey,
      limit,
    ),
  findEvidence: (sellerKey, scope) =>
    inventorySellingHistoryRepository.findEvidence(sellerKey, scope),
};

const noCoverage = (sellerKey: string): SellerOrderCoverage => ({
  sellerKey,
  source: "tcgplayer_api",
  status: "not_started",
  ordersObserved: 0,
  detailsRecorded: 0,
  gaps: [],
});

export async function loadInventorySellingHistory(
  sellerKey: string,
  options: { detailPage?: number; scope?: SellingHistoryScope } = {},
  dataSource: InventorySellingHistorySource = source,
): Promise<InventorySellingHistoryReport> {
  const seller = sellerKey.trim();
  if (!seller) {
    return {
      status: "unavailable",
      sellerKey: "",
      scope: options.scope ?? DEFAULT_SELLING_HISTORY_SCOPE,
      availableProductLines: [],
      reason: "seller_not_configured",
      orderCoverage: noCoverage(""),
      historicalPublicationEstimate: {
        status:"unavailable",reason:"source_read_failed",cutoffAt:null,
        summary:{publicationItemCount:0,publicationQuantity:0,confirmedAdditionCount:0,
          confirmedAdditionQuantity:0,estimatedAdditionCount:0,estimatedAdditionQuantity:0,
          unsupportedAdditionCount:0,unsupportedAdditionQuantity:0,estimatedSoldQuantity:0,
          estimatedRemainingAtCutoff:0,reconstructedOlderQuantity:0,
          reconstructedOlderRemainingAtCutoff:0,supportedSkuCount:0,conflictedSkuCount:0},
        cohorts:[],cohortCount:0,conflicts:[],conflictCount:0,
      },
    };
  }
  await dataSource.backfillSupportedForecastEvidence(seller, 500);
  return buildInventorySellingHistoryReport(
    await dataSource.findEvidence(
      seller,
      options.scope ?? DEFAULT_SELLING_HISTORY_SCOPE,
    ),
    options.detailPage ?? 1,
  );
}
