import { data } from "react-router";
import { skusDb, productsDb } from "~/datastores";
import { getProductDetails } from "~/tcgplayer/get-product-details";
import { processWithConcurrency } from "~/processWithConcurrency";
import type { Product } from "~/data-types/product";
import type { Sku } from "~/data-types/sku";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { skuIds, productIds } = body;

    if (!skuIds || !Array.isArray(skuIds)) {
      return data({ error: "skuIds array is required" }, { status: 400 });
    }

    if (!productIds || !Array.isArray(productIds)) {
      return data({ error: "productIds array is required" }, { status: 400 });
    }

    // Check which SKUs exist in the database
    const existingSkus = await skusDb.find<Sku>({ sku: { $in: skuIds } });
    const existingSkuSet = new Set(existingSkus.map((sku) => sku.sku));
    const missingSkuIds = skuIds.filter(
      (skuId: number) => !existingSkuSet.has(skuId)
    );

    if (missingSkuIds.length === 0) {
      return data({
        message: "All SKUs already exist in database",
        missingSkuIds: [],
        updatedProducts: 0,
        totalSkus: 0,
      });
    }

    // Update products and their SKUs for missing SKUs
    const uniqueProductIds = Array.from(new Set(productIds));
    let updatedProducts = 0;
    let totalSkus = 0;

    const PRODUCT_CONCURRENCY = 50;

    for await (const _ of processWithConcurrency(
      uniqueProductIds,
      PRODUCT_CONCURRENCY,
      async (productId: number) => {
        try {
          // Check if product details already exist
          let details: Product | null = await productsDb.findOne<Product>({
            productId,
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
                { productId: details.productId },
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

            // Check which SKUs need to be inserted
            const skuIdsToCheck = skusToUpsert.map((sku) => sku.sku);
            const existingSkusForProduct = await skusDb.find<Sku>({
              sku: { $in: skuIdsToCheck },
            });
            const existingSkuSetForProduct = new Set(
              existingSkusForProduct.map((s) => s.sku)
            );
            const skusToInsert = skusToUpsert.filter(
              (sku) => !existingSkuSetForProduct.has(sku.sku)
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

    return data({
      message: `SKU validation complete. Updated ${updatedProducts} products with ${totalSkus} total SKUs.`,
      missingSkuIds,
      updatedProducts,
      totalSkus,
    });
  } catch (error) {
    console.error("Error in validate-skus action:", error);
    return data({ error: String(error) }, { status: 500 });
  }
}
