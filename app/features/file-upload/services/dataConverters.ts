import type { PricedSku, TcgPlayerListing } from "../../../core/types/pricing";

/**
 * Base interface for converters that transform PricedSku data to output format
 */
export interface OutputConverter<TOutput> {
  convertFromPricedSkus(pricedSkus: PricedSku[]): TOutput[];
}

/**
 * Converts PricedSku data to TcgPlayerListing CSV format
 */
export class PricedSkuToTcgPlayerListingConverter
  implements OutputConverter<TcgPlayerListing>
{
  convertFromPricedSkus(pricedSkus: PricedSku[]): TcgPlayerListing[] {
    return pricedSkus.map((pricedSku): TcgPlayerListing => {
      return {
        "TCGplayer Id": pricedSku.sku.toString(),
        "Product Line": pricedSku.productLine || "",
        "Set Name": pricedSku.setName || "",
        Product: pricedSku.productName || "",
        "Sku Variant": pricedSku.variant || "",
        "Sku Condition": pricedSku.condition || "",
        "Sale Count": pricedSku.saleCount?.toString() || "",
        "Lowest Sale Price": pricedSku.lowestSalePrice?.toFixed(2) || "",
        "Highest Sale Price": pricedSku.highestSalePrice?.toFixed(2) || "",
        "TCG Market Price": pricedSku.tcgMarketPrice?.toFixed(2) || "",
        "Total Quantity": (pricedSku.quantity || 0).toString(),
        "Add to Quantity": (pricedSku.addToQuantity || 0).toString(),
        "TCG Marketplace Price": pricedSku.price?.toFixed(2) || "",
        "Previous Price": pricedSku.previousPrice?.toFixed(2) || "",
        "Suggested Price": pricedSku.suggestedPrice?.toFixed(2) || "",
        "Percentile Used": pricedSku.percentileUsed?.toString() || "",
        "Historical Sales Velocity (Days)":
          pricedSku.historicalSalesVelocityDays?.toString() || "",
        "Estimated Time to Sell (Days)":
          pricedSku.estimatedTimeToSellDays?.toString() || "",
        "Sales Count for Historical Calculation":
          pricedSku.salesCountForHistorical?.toString() || "",
        "Listings Count for Estimated Calculation":
          pricedSku.listingsCountForEstimated?.toString() || "",
        Error: pricedSku.errors?.join("; ") || "",
        Warning: pricedSku.warnings?.join("; ") || "",
      };
    });
  }
}
