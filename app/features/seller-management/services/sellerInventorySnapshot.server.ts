import {
  getAllProducts,
  type GetProductsRequestBody,
} from "~/integrations/tcgplayer/client/get-search-results.server";
import type { SellerInventoryItem } from "~/features/inventory-management/services/inventoryConverter";

interface FetchSellerInventorySnapshotParams {
  sellerKey: string;
  excludeProductLineIds?: number[];
}

interface SellerInventorySnapshotResult {
  inventory: SellerInventoryItem[];
  totalProducts: number;
  sellerKey: string;
}

export async function fetchSellerInventorySnapshot({
  sellerKey,
  excludeProductLineIds,
}: FetchSellerInventorySnapshotParams): Promise<SellerInventorySnapshotResult> {
  const searchRequest: GetProductsRequestBody = {
    size: 24,
    listingSearch: {
      context: {
        cart: {},
      },
      filters: {
        term: {
          sellerStatus: "Live",
          channelId: 0,
          sellerKey: [sellerKey],
        },
        range: {
          quantity: {
            gte: 1,
          },
        },
        exclude: {
          channelExclusion: 0,
        },
      },
    },
  };

  let products = await getAllProducts(searchRequest);

  if (
    excludeProductLineIds &&
    Array.isArray(excludeProductLineIds) &&
    excludeProductLineIds.length > 0
  ) {
    const excludeSet = new Set(excludeProductLineIds);
    products = products.filter(
      (product) => !excludeSet.has(product.productLineId),
    );
  }

  const inventory = products.map((product) => ({
    productId: product.productId,
    productName: product.productName,
    setName: product.setName,
    productLineName: product.productLineName,
    rarity: product.rarityName,
    condition: product.listings[0]?.condition || "Unknown",
    marketPrice: product.marketPrice || 0,
    lowestPrice: product.lowestPrice,
    listings: product.listings,
    customAttributes: product.customAttributes,
  }));

  inventory.sort((a, b) => {
    const productLineComparison = (a.productLineName || "").localeCompare(
      b.productLineName || "",
    );
    if (productLineComparison !== 0) {
      return productLineComparison;
    }

    const setNameComparison = (a.setName || "").localeCompare(
      b.setName || "",
    );
    if (setNameComparison !== 0) {
      return setNameComparison;
    }

    return (a.productName || "").localeCompare(b.productName || "");
  });

  return {
    inventory,
    totalProducts: inventory.length,
    sellerKey,
  };
}
