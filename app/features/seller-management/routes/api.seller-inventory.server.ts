import "server-only";
import { data } from "react-router";
import {
  getAllProducts,
  type GetProductsRequestBody,
} from "~/integrations/tcgplayer/client/get-search-results.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { sellerKey } = body;

    if (!sellerKey) {
      return data({ error: "Seller key is required" }, { status: 400 });
    }

    // Build the search request to get all products for this seller
    const searchRequest: GetProductsRequestBody = {
      size: 24, // API maximum
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

    // Fetch all products for the seller
    const products = await getAllProducts(searchRequest);

    // Convert products to seller inventory format
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

    // Sort inventory by product line, set name, and product name
    inventory.sort((a, b) => {
      // First sort by product line name
      const productLineComparison = (a.productLineName || "").localeCompare(
        b.productLineName || ""
      );
      if (productLineComparison !== 0) {
        return productLineComparison;
      }

      // Then sort by set name
      const setNameComparison = (a.setName || "").localeCompare(
        b.setName || ""
      );
      if (setNameComparison !== 0) {
        return setNameComparison;
      }

      // Finally sort by product name
      return (a.productName || "").localeCompare(b.productName || "");
    });

    return data({
      inventory,
      totalProducts: products.length,
      sellerKey,
    });
  } catch (error: any) {
    console.error("Error fetching seller inventory:", error);
    return data(
      {
        error: error?.message || "Failed to fetch seller inventory",
        inventory: [],
        totalProducts: 0,
      },
      { status: 500 }
    );
  }
}

// No default export - this is an API-only route
