import { data } from "react-router";
import type { PricerSku, TcgPlayerListing } from "~/core/types/pricing";
import type { SellerInventoryItem } from "~/features/inventory-management/services/inventoryConverter";
import { productLinesDb, skusDb } from "~/datastores.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { listings, type } = body;

    if (!listings || !Array.isArray(listings)) {
      return data({ error: "listings array is required" }, { status: 400 });
    }

    if (!type || (type !== "csv" && type !== "seller-inventory")) {
      return data(
        { error: "type must be either 'csv' or 'seller-inventory'" },
        { status: 400 }
      );
    }

    let results: PricerSku[] = [];

    if (type === "csv") {
      // Handle CSV conversion
      const csvListings = listings as TcgPlayerListing[];

      // Filter out invalid SKUs first
      const validListings = csvListings.filter((listing) => {
        const skuId = Number(listing["TCGplayer Id"]);
        return !isNaN(skuId) && skuId > 0;
      });

      // Get all unique product line names to look up IDs
      const uniqueProductLines = Array.from(
        new Set(
          validListings
            .map((listing) => listing["Product Line"])
            .filter(Boolean)
        )
      );

      // Look up product line IDs
      const productLineMap = new Map<string, number>();
      for (const productLineName of uniqueProductLines) {
        try {
          const productLine = await productLinesDb.findOne({
            $or: [
              { productLineName: productLineName },
              {
                productLineUrlName: productLineName
                  .toLowerCase()
                  .replace(/\s+/g, "-"),
              },
            ],
          });
          if (productLine) {
            productLineMap.set(productLineName, productLine.productLineId);
          }
        } catch (error) {
          console.warn(
            `Failed to lookup product line: ${productLineName}`,
            error
          );
        }
      }

      // Process each listing and look up metadata
      for (const listing of validListings) {
        const skuId = Number(listing["TCGplayer Id"]);
        const productLineName = listing["Product Line"];

        if (!productLineName) {
          continue;
        }

        const productLineId = productLineMap.get(productLineName);
        if (!productLineId) {
          console.warn(
            `Product line not found: ${productLineName} for SKU ${skuId}`
          );
          continue;
        }

        // Look up SKU metadata using sharded database
        let skuMetadata;
        try {
          skuMetadata = await skusDb.findOne({
            sku: skuId,
            productLineId: productLineId,
          });
        } catch (error) {
          console.warn(
            `Failed to lookup SKU ${skuId} in product line ${productLineId}:`,
            error
          );
          continue;
        }

        if (!skuMetadata) {
          console.warn(
            `SKU ${skuId} not found in product line ${productLineName} (${productLineId})`
          );
          continue;
        }

        // Validate that all required metadata is present
        if (
          !skuMetadata.productLineId ||
          !skuMetadata.setId ||
          !skuMetadata.productId
        ) {
          console.warn(`SKU ${skuId} missing required metadata:`, {
            productLineId: skuMetadata.productLineId,
            setId: skuMetadata.setId,
            productId: skuMetadata.productId,
          });
          continue;
        }

        const quantity = Number(listing["Total Quantity"]) || 0;
        const addToQuantity = Number(listing["Add to Quantity"]) || 0;
        const currentPrice =
          Number(listing["TCG Marketplace Price"]) || undefined;

        results.push({
          sku: skuId,
          quantity: quantity > 0 ? quantity : undefined,
          addToQuantity: addToQuantity > 0 ? addToQuantity : undefined,
          currentPrice,
          productLineId: skuMetadata.productLineId,
          setId: skuMetadata.setId,
          productId: skuMetadata.productId,
        });
      }
    } else if (type === "seller-inventory") {
      // Handle seller inventory conversion
      const inventory = listings as SellerInventoryItem[];

      // Build a map of SKU ID -> inventory item with product line context
      const skuMap = new Map<
        number,
        {
          quantity: number;
          price?: number;
          productLineName: string;
        }
      >();

      inventory.forEach((item) => {
        // Filter out custom listings (those with customListingId)
        const regularListings =
          item.listings?.filter(
            (listing: any) => !listing.customData?.customListingId
          ) || [];

        regularListings.forEach((listing: any) => {
          const skuId = listing.productConditionId;
          if (skuId && skuId > 0) {
            skuMap.set(skuId, {
              quantity: listing.quantity,
              price: listing.price || undefined,
              productLineName: item.productLineName,
            });
          }
        });
      });

      // Get all unique product line names to look up IDs
      const uniqueProductLines = Array.from(
        new Set(
          Array.from(skuMap.values())
            .map((item) => item.productLineName)
            .filter(Boolean)
        )
      );

      // Look up product line IDs
      const productLineMap = new Map<string, number>();
      for (const productLineName of uniqueProductLines) {
        try {
          const productLine = await productLinesDb.findOne({
            $or: [
              { productLineName: productLineName },
              {
                productLineUrlName: productLineName
                  .toLowerCase()
                  .replace(/\s+/g, "-"),
              },
            ],
          });
          if (productLine) {
            productLineMap.set(productLineName, productLine.productLineId);
          }
        } catch (error) {
          console.warn(
            `Failed to lookup product line: ${productLineName}`,
            error
          );
        }
      }

      // Process each SKU and look up metadata
      const skuEntries = Array.from(skuMap.entries());

      // Deduplicate by SKU ID to prevent processing the same SKU multiple times
      const processedSkus = new Set<number>();

      for (const [skuId, inventoryData] of skuEntries) {
        if (processedSkus.has(skuId)) {
          continue; // Skip already processed SKUs
        }
        processedSkus.add(skuId);

        const productLineName = inventoryData.productLineName;
        if (!productLineName) {
          continue;
        }

        const productLineId = productLineMap.get(productLineName);
        if (!productLineId) {
          console.warn(
            `Product line not found: ${productLineName} for SKU ${skuId}`
          );
          continue;
        }

        // Look up SKU metadata using sharded database
        let skuMetadata;
        try {
          skuMetadata = await skusDb.findOne({
            sku: skuId,
            productLineId: productLineId,
          });
        } catch (error) {
          console.warn(
            `Failed to lookup SKU ${skuId} in product line ${productLineId}:`,
            error
          );
          continue;
        }

        if (!skuMetadata) {
          console.warn(
            `SKU ${skuId} not found in product line ${productLineName} (${productLineId})`
          );
          continue;
        }

        // Validate that all required metadata is present
        if (
          !skuMetadata.productLineId ||
          !skuMetadata.setId ||
          !skuMetadata.productId
        ) {
          console.warn(`SKU ${skuId} missing required metadata:`, {
            productLineId: skuMetadata.productLineId,
            setId: skuMetadata.setId,
            productId: skuMetadata.productId,
          });
          continue;
        }

        results.push({
          sku: skuId,
          quantity: inventoryData.quantity,
          currentPrice: inventoryData.price,
          productLineId: skuMetadata.productLineId,
          setId: skuMetadata.setId,
          productId: skuMetadata.productId,
        });
      }
    }

    return data({
      pricerSkus: results,
      totalProcessed: listings.length,
      validSkus: results.length,
    });
  } catch (error) {
    console.error("Error in convert-to-pricer-sku action:", error);
    return data({ error: String(error) }, { status: 500 });
  }
}
