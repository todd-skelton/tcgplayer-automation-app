import "server-only";
import { data } from "react-router";
import { getProductDetails } from "~/integrations/tcgplayer/client/get-product-details.server";
import { processWithConcurrency } from "~/core/processWithConcurrency";
import type { Product } from "~/features/inventory-management/types/product";
import type { Sku } from "~/shared/data-types/sku";
import { skusDb, productsDb } from "~/datastores.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { productLineSkus } = body;

    // Validate the required structure: { [productLineId]: { [productId]: sku[] } }
    if (!productLineSkus || typeof productLineSkus !== "object") {
      return data(
        {
          error:
            "productLineSkus object is required with structure: { [productLineId]: { [productId]: sku[] } }",
        },
        { status: 400 }
      );
    }

    // Validate the nested structure
    for (const [productLineId, productMap] of Object.entries(productLineSkus)) {
      if (!productMap || typeof productMap !== "object") {
        return data(
          {
            error: `Invalid structure for productLineId ${productLineId}: must be an object with productId keys`,
          },
          { status: 400 }
        );
      }

      for (const [productId, skus] of Object.entries(
        productMap as Record<string, any>
      )) {
        if (!Array.isArray(skus)) {
          return data(
            {
              error: `Invalid structure for productId ${productId} in productLineId ${productLineId}: skus must be an array`,
            },
            { status: 400 }
          );
        }
      }
    }

    // Extract all SKU IDs for validation (no need to flatten product IDs anymore)
    const allSkuIds: number[] = [];

    for (const [productLineId, productMap] of Object.entries(productLineSkus)) {
      for (const [productId, skus] of Object.entries(
        productMap as Record<string, number[]>
      )) {
        allSkuIds.push(...skus);
      }
    }

    // Check which SKUs exist in the database for each product line (optimized sharded queries)
    const existingSkusByProductLine: Record<number, Set<number>> = {};
    let totalExistingSkus = 0;

    for (const [productLineId, skuIds] of Object.entries(productLineSkus)) {
      const productLineIdNum = parseInt(productLineId);
      const allSkusForProductLine: number[] = [];

      for (const skus of Object.values(
        productLineSkus[productLineId] as Record<string, number[]>
      )) {
        allSkusForProductLine.push(...skus);
      }

      if (allSkusForProductLine.length > 0) {
        const existingSkus = await skusDb.find<Sku>({
          sku: { $in: allSkusForProductLine },
          productLineId: productLineIdNum,
        });

        existingSkusByProductLine[productLineIdNum] = new Set(
          existingSkus.map((sku) => sku.sku)
        );
        totalExistingSkus += existingSkus.length;
      }
    }

    // Calculate missing SKUs by product line
    const missingSkusByProductLine: Record<
      number,
      Record<number, number[]>
    > = {};
    let totalMissingSkus = 0;

    for (const [productLineId, productMap] of Object.entries(productLineSkus)) {
      const productLineIdNum = parseInt(productLineId);
      const existingSkuSet =
        existingSkusByProductLine[productLineIdNum] || new Set();

      missingSkusByProductLine[productLineIdNum] = {};

      for (const [productId, skus] of Object.entries(
        productMap as Record<string, number[]>
      )) {
        const productIdNum = parseInt(productId);
        const missingSkus = skus.filter((sku) => !existingSkuSet.has(sku));

        if (missingSkus.length > 0) {
          missingSkusByProductLine[productLineIdNum][productIdNum] =
            missingSkus;
          totalMissingSkus += missingSkus.length;
        }
      }
    }

    if (totalMissingSkus === 0) {
      return data({
        message: "All SKUs already exist in database",
        missingSkusByProductLine: {},
        updatedProducts: 0,
        totalSkus: totalExistingSkus,
      });
    }

    // Update products and their SKUs for missing SKUs - process by product line for optimal sharding
    let updatedProducts = 0;
    let totalSkus = 0;

    const PRODUCT_CONCURRENCY = 50;

    // Process each product line separately for optimal sharding
    for (const [productLineId, productMap] of Object.entries(productLineSkus)) {
      const productLineIdNum = parseInt(productLineId);
      const typedProductMap = productMap as Record<string, number[]>;

      // Only process products that have missing SKUs in this product line
      const productsWithMissingSkus = Object.keys(
        missingSkusByProductLine[productLineIdNum] || {}
      ).map(Number);

      if (productsWithMissingSkus.length === 0) {
        continue; // Skip this product line if no missing SKUs
      }

      for await (const _ of processWithConcurrency(
        productsWithMissingSkus,
        PRODUCT_CONCURRENCY,
        async (productId: number) => {
          try {
            // We already know the product line ID - no need to look it up!
            const requestedSkus = typedProductMap[productId.toString()];
            const missingSkusForProduct =
              missingSkusByProductLine[productLineIdNum][productId];

            // Use targeted product lookup with known product line ID (optimized for sharding)
            let details: Product | null = await productsDb.findOne({
              productId,
              productLineId: productLineIdNum,
            });

            if (!details || !details.skus || !details.skus.length) {
              // Fetch fresh product details from API
              const fetched = await getProductDetails({ id: productId });
              if (fetched) {
                details = {
                  productTypeName: fetched.productTypeName,
                  rarityName: fetched.rarityName,
                  sealed: fetched.sealed,
                  productName: fetched.productName,
                  setId: fetched.setId,
                  setCode: fetched.setCode,
                  productId: fetched.productId,
                  setName: fetched.setName,
                  productLineId: fetched.productLineId,
                  productStatusId: fetched.productStatusId,
                  productLineName: fetched.productLineName,
                  skus: fetched.skus,
                };
                // Upsert the product details
                await productsDb.update(
                  {
                    productId: details.productId,
                    productLineId: details.productLineId,
                  },
                  details,
                  { upsert: true }
                );
              }
            }

            if (details && details.skus && details.skus.length) {
              updatedProducts++;
              totalSkus += details.skus.length;

              // Prepare SKUs for upsert
              const skusToUpsert: Sku[] = details.skus.map((sku) => ({
                ...sku,
                productTypeName: details.productTypeName,
                rarityName: details.rarityName,
                sealed: details.sealed,
                productName: details.productName,
                setId: details.setId,
                setCode: details.setCode,
                productId: details.productId,
                setName: details.setName,
                productLineId: details.productLineId,
                productStatusId: details.productStatusId,
                productLineName: details.productLineName,
              }));

              // Only insert SKUs that were identified as missing for this product
              const skusToInsert = skusToUpsert.filter(
                (sku) =>
                  requestedSkus.includes(sku.sku) &&
                  missingSkusForProduct.includes(sku.sku)
              );

              if (skusToInsert.length > 0) {
                try {
                  await skusDb.insert(skusToInsert);
                } catch (err) {
                  console.error(
                    `Error inserting SKUs for product ${productId}:`,
                    err
                  );
                }
              }
            }
          } catch (err) {
            console.error(`Error updating product ${productId}:`, err);
          }
        }
      )) {
        // No-op
      }
    }

    return data({
      message: `SKU validation complete. Updated ${updatedProducts} products with ${totalSkus} total SKUs.`,
      missingSkusByProductLine,
      updatedProducts,
      totalSkus,
    });
  } catch (error) {
    console.error("Error in validate-skus action:", error);
    return data({ error: String(error) }, { status: 500 });
  }
}
