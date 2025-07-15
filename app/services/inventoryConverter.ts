import type { Product, Listing } from "../tcgplayer/get-search-results";
import type { TcgPlayerListing } from "../types/pricing";

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
    "TCGplayer Id": listing.productConditionId.toString(), // This is the SKU (product + condition combination)
    "Product Line": product.productLineName,
    "Set Name": product.setName,
    "Product Name": product.productName,
    Title: listing.customData?.title || "",
    Number: product.customAttributes?.number || "",
    Rarity: product.rarityName,
    Condition: listing.condition,
    "TCG Market Price": "", // SKU-level market price will be fetched separately by ListingProcessor
    "TCG Direct Low": "",
    "TCG Low Price With Shipping":
      product.lowestPriceWithShipping?.toString() || "",
    "TCG Low Price": product.lowestPrice?.toString() || "",
    "Total Quantity": listing.quantity.toString(),
    "Add to Quantity": "0",
    "TCG Marketplace Price": listing.price.toString(),
    "Photo URL": "",
  };
}

export function convertSellerInventoryToListings(
  inventory: SellerInventoryItem[]
): TcgPlayerListing[] {
  const listings: TcgPlayerListing[] = [];

  inventory.forEach((item) => {
    // Filter out custom listings (those with customListingId)
    // Custom listings have manually set prices and shouldn't be processed by pricing algorithms
    const regularListings = item.listings.filter(
      (listing) => !listing.customData?.customListingId
    );

    regularListings.forEach((listing) => {
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

  return listings;
}
