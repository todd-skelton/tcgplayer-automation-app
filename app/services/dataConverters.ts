import type { PricerSku, PricedSku, TcgPlayerListing } from "../types/pricing";
import type { Listing } from "../tcgplayer/get-search-results";
import type { SellerInventoryItem } from "../services/inventoryConverter";
import type { PendingInventoryEntry } from "../data-types/pendingInventory";

/**
 * Base interface for converters that transform input data to PricerSku format
 */
export interface InputConverter<TInput> {
  convertToPricerSkus(input: TInput[]): PricerSku[];
}

/**
 * Base interface for converters that transform PricedSku data to output format
 */
export interface OutputConverter<TOutput> {
  convertFromPricedSkus(pricedSkus: PricedSku[]): TOutput[];
}

/**
 * Converts CSV TcgPlayerListing data to PricerSku format
 */
export class CsvToPricerSkuConverter
  implements InputConverter<TcgPlayerListing>
{
  convertToPricerSkus(listings: TcgPlayerListing[]): PricerSku[] {
    return listings
      .filter((listing) => {
        // Skip invalid SKUs
        const skuId = Number(listing["TCGplayer Id"]);
        return !isNaN(skuId) && skuId > 0;
      })
      .map((listing): PricerSku => {
        const skuId = Number(listing["TCGplayer Id"]);
        const quantity = Number(listing["Total Quantity"]) || 0;
        const addToQuantity = Number(listing["Add to Quantity"]) || 0;
        const currentPrice =
          Number(listing["TCG Marketplace Price"]) || undefined;

        return {
          sku: skuId,
          quantity: quantity > 0 ? quantity : undefined,
          addToQuantity: addToQuantity > 0 ? addToQuantity : undefined,
          currentPrice,
        };
      });
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
        "Expected Days to Sell": pricedSku.expectedDaysToSell?.toString() || "",
        Error: pricedSku.errors?.join("; ") || "",
        Warning: pricedSku.warnings?.join("; ") || "",
      };
    });
  }
}

/**
 * Converts seller inventory to PricerSku format
 * Deduplicates SKUs to prevent processing the same item multiple times
 */
export class SellerInventoryToPricerSkuConverter
  implements InputConverter<SellerInventoryItem>
{
  convertToPricerSkus(inventory: SellerInventoryItem[]): PricerSku[] {
    const skuMap = new Map<number, PricerSku>();

    inventory.forEach((item) => {
      // Filter out custom listings (those with customListingId)
      const regularListings =
        item.listings?.filter(
          (listing: Listing) => !listing.customData?.customListingId
        ) || [];

      regularListings.forEach((listing: Listing) => {
        const skuId = listing.productConditionId;
        if (skuId && skuId > 0) {
          skuMap.set(skuId, {
            sku: skuId,
            quantity: listing.quantity,
            addToQuantity: 0, // Seller inventory doesn't typically have add quantity
            currentPrice: listing.price || undefined,
          });
        }
      });
    });

    return Array.from(skuMap.values());
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
        };
      });
  }
}
