import { getAllProducts } from "../integrations/tcgplayer/client/get-search-results.server";
import { type SetProduct } from "../shared/data-types/setProduct";
import { type CategorySet } from "../shared/data-types/categorySet";
import { getProductDetails } from "../integrations/tcgplayer/client/get-product-details.server";
import { getCatalogSetNames } from "../integrations/tcgplayer/client/get-catalog-set-names.server";
import type { Product } from "../features/inventory-management/types/product";
import type { Sku } from "../shared/data-types/sku";
import { processWithConcurrency } from "../core/processWithConcurrency";
import type { ProductLine } from "../shared/data-types/productLine";
import {
  categorySetsDb,
  getProductsDbShard,
  setProductsDb,
  getSkusDbShard,
  productLinesDb,
  categoryFiltersDb,
} from "../datastores.server";
import { getCategoryFilters } from "../integrations/tcgplayer/client/get-category-filters.server";
import { getProductLines } from "../integrations/tcgplayer/client/get-product-lines.server";

/**
 * Fetches and upserts all sets for a given categoryId. Always calls the API to verify all sets are in the database.
 */
export async function fetchAndUpsertCategorySets(categoryId: number) {
  console.log(
    `[fetchAndUpsertCategorySets] Starting for categoryId: ${categoryId}`
  );

  // Find the selected product line to get the url name
  const selectedProductLine = await productLinesDb.findOne({
    productLineId: categoryId,
  });
  if (!selectedProductLine) {
    throw new Error(`No product line found for categoryId ${categoryId}`);
  }

  console.log(
    `[fetchAndUpsertCategorySets] Found product line: ${selectedProductLine.productLineName}`
  );

  // Always fetch from API to ensure we have the latest sets
  console.log(`[fetchAndUpsertCategorySets] Calling getCatalogSetNames API...`);
  const fetchedSetsResp = await getCatalogSetNames({ categoryId });
  const fetchedSets = fetchedSetsResp.results;
  if (!fetchedSets || !fetchedSets.length) {
    throw new Error(
      `No sets found from getCatalogSetNames for categoryId ${categoryId}`
    );
  }

  console.log(
    `[fetchAndUpsertCategorySets] API returned ${fetchedSets.length} sets`
  );

  // Get existing sets from database
  console.log(
    `[fetchAndUpsertCategorySets] Querying existing sets from database...`
  );
  const existingSets = await categorySetsDb.find({ categoryId });
  const existingSetIds = new Set(existingSets.map((set) => set.setNameId));

  // Identify missing sets that need to be inserted
  const missingSets = fetchedSets.filter(
    (set) => !existingSetIds.has(set.setNameId)
  );

  console.log(
    `[fetchAndUpsertCategorySets] Found ${existingSets.length} existing sets, ${missingSets.length} missing sets`
  );

  // Upsert all fetched sets (will update existing and insert missing)
  console.log(
    `[fetchAndUpsertCategorySets] Upserting ${fetchedSets.length} sets...`
  );
  await Promise.all(
    fetchedSets.map((set: CategorySet) =>
      categorySetsDb.update({ setNameId: set.setNameId }, set, {
        upsert: true,
      })
    )
  );

  // Log information about what was found/updated
  console.log(
    `Category ${categoryId}: Found ${fetchedSets.length} total sets, ${missingSets.length} were missing from database`
  );

  console.log(`[fetchAndUpsertCategorySets] Completed successfully`);
  return {
    sets: fetchedSets,
    productLine: selectedProductLine,
  };
}

/**
 * Fetches and upserts all set products for a list of sets and a product line name. Returns all set products.
 */
export async function fetchAndUpsertSetProducts(
  sets: CategorySet[],
  productLine: ProductLine
) {
  let allSetProducts: SetProduct[] = [];
  for (let setIdx = 0; setIdx < sets.length; setIdx++) {
    const set = sets[setIdx];
    let products: SetProduct[] = await setProductsDb.find({
      setNameId: set.setNameId,
    });
    if (!products.length) {
      try {
        const productsResp = await getAllProducts({
          size: 24,
          filters: {
            term: {
              productLineName: [productLine.productLineName],
              setName: [set.cleanSetName],
            },
          },
          sort: { field: "product-sorting-name", order: "asc" },
        });
        const seen = new Set<number>();
        products = [];
        for (const card of productsResp) {
          if (seen.has(card.productId)) continue;
          seen.add(card.productId);
          products.push({
            setNameId: set.setNameId,
            productId: card.productId,
            game: productLine.productLineName,
            number: card.customAttributes?.number ?? "",
            productName: card.productName,
            rarity: card.rarityName,
            set: card.setName,
            setAbbrv: card.setUrlName,
            type: card.customAttributes?.cardType?.join(", ") ?? "",
          });
        }
        await Promise.all(
          products.map((prod) =>
            setProductsDb.update({ productID: prod.productId }, prod, {
              upsert: true,
            })
          )
        );
      } catch (err) {
        continue;
      }
    }
    allSetProducts.push(...products);
  }
  return allSetProducts;
}

/**
 * Fetches and upserts product details and SKUs for a list of set products. Returns product and SKU counts.
 */
export async function fetchAndUpsertProductsAndSkus(
  allSetProducts: SetProduct[],
  productLineId: number
) {
  console.log(
    `[fetchAndUpsertProductsAndSkus] Starting with ${allSetProducts.length} products for productLineId: ${productLineId}`
  );
  let productCount = 0;
  let totalSkus = 0;
  const PRODUCT_CONCURRENCY = 5;
  let prodIdx = 0;

  // Get the specific shards for this product line (will be created if they don't exist)
  const productsDbShard = getProductsDbShard(productLineId);
  const skusDbShard = getSkusDbShard(productLineId);

  try {
    for await (const _ of processWithConcurrency(
      allSetProducts,
      PRODUCT_CONCURRENCY,
      async (product) => {
        prodIdx += 1;
        if (prodIdx % 10 === 0) {
          console.log(
            `[fetchAndUpsertProductsAndSkus] Processing product ${prodIdx}/${allSetProducts.length}`
          );
        }

        const productId = product.productId;
        let details: Product | null = await productsDbShard.findOne<Product>({
          productId,
          productLineId,
        });

        if (!details || !details.skus || !details.skus.length) {
          try {
            const fetched = await getProductDetails({ id: productId });
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
            await productsDbShard.update(
              {
                productId: details.productId,
                productLineId: details.productLineId,
              },
              details,
              { upsert: true }
            );
          } catch (err) {
            console.warn(
              `[fetchAndUpsertProductsAndSkus] Failed to fetch product ${productId}:`,
              err
            );
            return;
          }
        }

        productCount++;
        totalSkus += details.skus.length;

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

        const skuIds = skusToUpsert.map((sku) => sku.sku);
        const existingSkus = await skusDbShard.find<Sku>({
          sku: { $in: skuIds },
          productLineId: details.productLineId,
        });
        const existingSkuSet = new Set(existingSkus.map((s) => s.sku));
        const skusToInsert = skusToUpsert.filter(
          (sku) => !existingSkuSet.has(sku.sku)
        );

        if (skusToInsert.length > 0) {
          try {
            await skusDbShard.insert(skusToInsert);
          } catch (err) {
            console.warn(
              `[fetchAndUpsertProductsAndSkus] Failed to insert SKUs for product ${productId}:`,
              err
            );
          }
        }
      }
    )) {
      // No-op
    }

    console.log(
      `[fetchAndUpsertProductsAndSkus] Completed successfully. Products: ${productCount}, SKUs: ${totalSkus}`
    );
    return { productCount, totalSkus };
  } catch (error) {
    console.error(
      `[fetchAndUpsertProductsAndSkus] Error during processing:`,
      error
    );
    throw error;
  }
}

export async function fetchAllProductLines() {
  const productLines = await getProductLines();
  if (!productLines || !productLines.length) {
    throw new Error("No product lines returned from API");
  }
  await Promise.all(
    productLines.map(async (pl: ProductLine) => {
      await productLinesDb.update({ productLineId: pl.productLineId }, pl, {
        upsert: true,
      });
      // Fetch and store category filters for each product line
      try {
        const filters = await getCategoryFilters(pl.productLineId);
        if (filters) {
          await categoryFiltersDb.update(
            { categoryId: pl.productLineId },
            { categoryId: pl.productLineId, ...filters },
            { upsert: true }
          );
        }
      } catch (error) {
        console.warn(
          `Failed to fetch category filters for product line ${pl.productLineId}:`,
          error
        );
      }
    })
  );
  return productLines;
}
