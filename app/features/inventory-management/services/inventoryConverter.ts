import type {
  Product,
  Listing,
} from "../../../integrations/tcgplayer/client/get-search-results";
import type { TcgPlayerListing } from "../../../core/types/pricing";

export interface SellerInventoryItem {
  productId: number;
  productName: string;
  setName: string;
  productLineName: string;
  rarity: string;
  condition: string;
  marketPrice: number;
  lowestPrice?: number;
  listings: Listing[];
  customAttributes?: any;
}

export function convertProductToListing(
  product: Product,
  listing: Listing
): TcgPlayerListing {
  return {
    "TCGplayer Id": listing.productConditionId.toString(),
    "Product Line": product.productLineName,
    "Set Name": product.setName,
    Product: product.productName,
    "Sku Variant": listing.printing || "",
    "Sku Condition": listing.condition,
    "Sale Count": "",
    "Lowest Sale Price": "",
    "Highest Sale Price": "",
    "TCG Market Price": "",
    "Total Quantity": listing.quantity.toString(),
    "Add to Quantity": "0",
    "TCG Marketplace Price": listing.price.toString(),
    "Previous Price": "",
    "Suggested Price": "",
    "Historical Sales Velocity (Days)": "",
    "Estimated Time to Sell (Days)": "",
    "Sales Count for Historical Calculation": "",
    "Listings Count for Estimated Calculation": "",
    Warning: "",
    Error: "",
  };
}

export function convertSellerInventoryToListings(
  inventory: SellerInventoryItem[]
): { listings: TcgPlayerListing[]; duplicatesFound: number } {
  const listings: TcgPlayerListing[] = [];
  const seenSkuIds = new Set<string>();
  let duplicatesFound = 0;

  inventory.forEach((item) => {
    // Filter out custom listings (those with customListingId)
    // Custom listings have manually set prices and shouldn't be processed by pricing algorithms
    const regularListings = item.listings.filter(
      (listing) => !listing.customData?.customListingId
    );

    regularListings.forEach((listing) => {
      const skuId = listing.productConditionId.toString();

      // Check for duplicate SKU IDs
      if (seenSkuIds.has(skuId)) {
        console.warn(
          `Duplicate SKU ID found: ${skuId}. Skipping duplicate listing.`
        );
        duplicatesFound++;
        return;
      }

      seenSkuIds.add(skuId);

      const tcgListing = convertProductToListing(
        {
          productId: item.productId,
          productName: item.productName,
          setName: item.setName,
          productLineName: item.productLineName,
          rarityName: item.rarity,
          marketPrice: item.marketPrice,
          lowestPrice: item.lowestPrice,
          customAttributes: item.customAttributes,
        } as Product,
        listing
      );
      listings.push(tcgListing);
    });
  });

  return { listings, duplicatesFound };
}
