import type { InventoryPublicationForecastEvidence } from "~/features/inventory-publication/types/inventoryPublication";
import type { SellerOrderCoverage } from "~/features/seller-order-history/types/sellerOrderHistory";

export const SELL_THROUGH_HORIZONS = [7, 30, 60, 90] as const;
export const SELLING_HISTORY_WINDOWS = [90, 180, 365, 730] as const;

export interface SellingHistoryScope {
  windowDays: (typeof SELLING_HISTORY_WINDOWS)[number];
  productLine: string | null;
}

export const DEFAULT_SELLING_HISTORY_SCOPE: SellingHistoryScope = {
  windowDays: 180,
  productLine: null,
};

export type SellingHistoryEpisodeKind =
  | "confirmed_publication"
  | "opening_balance"
  | "physical_restock"
  | "order_quantity_correction";

export interface SellingHistoryEpisodeEvidence {
  episodeKey: string;
  receiptId: number;
  sku: number;
  productLine: string;
  productName: string;
  kind: SellingHistoryEpisodeKind;
  quantity: number;
  listedAt: string | null;
  forecastEvidence: InventoryPublicationForecastEvidence | null;
  forecastEvidenceProvenance: "recorded" | "estimated" | "unknown";
}

export interface SellingHistoryOutcomeEvidence {
  episodeKey: string;
  kind: "sale" | "removed";
  quantity: number;
  happenedAt: string;
  orderNumber: string | null;
  orderLineId: string | null;
  source: "seller_order" | "cancellation" | "quantity_correction";
}

export interface SellingHistorySourceEvidence {
  sellerKey: string;
  scope: SellingHistoryScope;
  availableProductLines: string[];
  analysisFrom: string;
  inventoryObservedAt: string | null;
  orderCoverage: SellerOrderCoverage;
  episodes: SellingHistoryEpisodeEvidence[];
  episodeCount: number;
  outcomes: SellingHistoryOutcomeEvidence[];
  outcomeCount: number;
  projection: {
    pendingQuantity: number;
    heldQuantity: number;
    affectedSkus: number[];
  };
  openingUnknownQuantity: number;
  legacyUnlinked: {
    quantity: number;
    forecastQuantity: number;
  };
  olderPublicationQuantity: number;
  awaitingCutoffQuantity: number;
  unresolvedRemoval: {
    quantity: number;
    affectedSkus: number[];
  };
}

export interface SellThroughHorizon {
  days: number;
  eligibleQuantity: number;
  soldQuantity: number;
  rate: number | null;
  status: "exact" | "unsettled_outcomes";
}

export interface SellingHistorySummary {
  cohortQuantity: number;
  knownListedDateQuantity: number;
  unknownListedDateQuantity: number;
  soldQuantity: number;
  soldWithKnownListedDateQuantity: number;
  remainingWithKnownAgeQuantity: number;
  remainingWithUncertainPresenceQuantity: number;
  removedQuantity: number;
  soldOnlyAverageDays: number | null;
  medianDaysToSale: number | null;
  p90DaysToSale: number | null;
  percentileStatus:
    | "estimable"
    | "not_reached"
    | "competing_removals"
    | "unsettled_outcomes";
  sellThrough: SellThroughHorizon[];
}

export interface SellingHistoryProductLine extends SellingHistorySummary {
  productLine: string;
}

export interface SellingHistoryEpisodeDetail {
  episodeKey: string;
  receiptId: number;
  sku: number;
  productLine: string;
  productName: string;
  kind: SellingHistoryEpisodeKind;
  quantity: number;
  listedAt: string | null;
  soldQuantity: number;
  removedQuantity: number;
  ledgerRemainingQuantity: number;
  remainingAgeDays: number | null;
  presenceUncertain: boolean;
  forecastEvidenceProvenance: "recorded" | "estimated" | "unknown";
  forecastEvidence: InventoryPublicationForecastEvidence | null;
  orders: Array<{
    orderNumber: string;
    quantity: number;
    soldAt: string;
    listedDays: number | null;
  }>;
}

export type InventorySellingHistoryReport =
  | {
      status: "unavailable";
      sellerKey: string;
      scope: SellingHistoryScope;
      availableProductLines: string[];
      reason:
        | "seller_not_configured"
        | "inventory_coverage_missing"
        | "order_coverage_incomplete"
        | "history_bounds_exceeded";
      orderCoverage: SellerOrderCoverage;
    }
  | {
      status: "ready";
      sellerKey: string;
      scope: SellingHistoryScope;
      availableProductLines: string[];
      asOf: string;
      analysisFrom: string;
      orderCoverage: SellerOrderCoverage;
      overall: SellingHistorySummary;
      productLines: SellingHistoryProductLine[];
      details: SellingHistoryEpisodeDetail[];
      detailTotal: number;
      detailPage: number;
      detailPageCount: number;
      coverage: {
        pendingProjectionQuantity: number;
        heldProjectionQuantity: number;
        unresolvedRemovalQuantity: number;
        affectedRemovalSkus: number;
        openingUnknownQuantity: number;
        legacyUnlinkedQuantity: number;
        legacyUnlinkedForecastQuantity: number;
        olderPublicationQuantity: number;
        awaitingCutoffQuantity: number;
      };
    };
