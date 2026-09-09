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
