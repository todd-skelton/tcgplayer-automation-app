import type {
  PricerSku,
  PricedSku,
  TcgPlayerListing,
} from "../../../core/types/pricing";
import type { Listing } from "../../../integrations/tcgplayer/client/get-search-results.server";
import type { SellerInventoryItem } from "../../inventory-management/services/inventoryConverter";
import type { PendingInventoryEntry } from "../../pending-inventory/types/pendingInventory";

/**
 * Base interface for converters that transform input data to PricerSku format
 */
export interface InputConverter<TInput> {
  convertToPricerSkus(input: TInput[]): PricerSku[] | Promise<PricerSku[]>;
}

/**
 * Base interface for converters that transform PricedSku data to output format
 */
export interface OutputConverter<TOutput> {
  convertFromPricedSkus(pricedSkus: PricedSku[]): TOutput[];
}

/**
 * Converts CSV TcgPlayerListing data to PricerSku format
 * Enhanced version that looks up missing performance metadata
 */
export class CsvToPricerSkuConverter
  implements InputConverter<TcgPlayerListing>
{
  async convertToPricerSkus(
    listings: TcgPlayerListing[]
  ): Promise<PricerSku[]> {
    // Use server-side API to avoid client-side database imports
    const response = await fetch("/api/convert-to-pricer-sku", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listings: listings,
        type: "csv",
      }),
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      throw new Error(errorData.error || "Failed to convert CSV to PricerSku");
    }

    const result = await response.json();
    return result.pricerSkus;
  }
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

/**
 * Converts seller inventory to PricerSku format
 * Enhanced version that looks up missing performance metadata
 * Deduplicates SKUs to prevent processing the same item multiple times
 * Uses product line information to avoid cross-shard searching
 */
export class SellerInventoryToPricerSkuConverter
  implements InputConverter<SellerInventoryItem>
{
  async convertToPricerSkus(
    inventory: SellerInventoryItem[]
  ): Promise<PricerSku[]> {
    // Use server-side API to avoid client-side database imports
    const response = await fetch("/api/convert-to-pricer-sku", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listings: inventory,
        type: "seller-inventory",
      }),
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      throw new Error(
        errorData.error || "Failed to convert seller inventory to PricerSku"
      );
    }

    const result = await response.json();
    return result.pricerSkus;
  }
}

/**
 * Converts pending inventory to PricerSku format
 */
export class PendingInventoryToPricerSkuConverter
  implements InputConverter<PendingInventoryEntry>
{
  convertToPricerSkus(pendingInventory: PendingInventoryEntry[]): PricerSku[] {
    return pendingInventory
      .filter((item) => item.sku && item.sku > 0)
      .map((item): PricerSku => {
        return {
          sku: item.sku,
          addToQuantity: item.quantity,
          // Performance metadata is now always available
          productLineId: item.productLineId,
          setId: item.setId,
          productId: item.productId,
        };
      });
  }
}
