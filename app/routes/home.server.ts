import { getCategoryFilters } from "../integrations/tcgplayer/client/get-category-filters.server";
import { getCatalogSetNames } from "../integrations/tcgplayer/client/get-catalog-set-names.server";
import { getProductDetails } from "../integrations/tcgplayer/client/get-product-details.server";
import { getProductLines } from "../integrations/tcgplayer/client/get-product-lines.server";
import { getAllProducts } from "../integrations/tcgplayer/client/get-search-results.server";
import { processWithConcurrency } from "../core/processWithConcurrency";
import {
  categoryFiltersRepository,
  categorySetsRepository,
  pendingInventoryRepository,
  productLinesRepository,
  productsRepository,
  setProductsRepository,
  skusRepository,
} from "../core/db";
import type { Product } from "../features/inventory-management/types/product";
import type { CategorySet } from "../shared/data-types/categorySet";
import type { ProductLine } from "../shared/data-types/productLine";
import type { SetProduct } from "../shared/data-types/setProduct";
import type { Sku } from "../shared/data-types/sku";

export async function fetchAndUpsertCategorySets(categoryId: number) {
  console.log(
    `[fetchAndUpsertCategorySets] Starting for categoryId: ${categoryId}`,
  );

  const selectedProductLine = await productLinesRepository.findById(categoryId);
  if (!selectedProductLine) {
    throw new Error(`No product line found for categoryId ${categoryId}`);
  }

  console.log(
    `[fetchAndUpsertCategorySets] Found product line: ${selectedProductLine.productLineName}`,
  );

  const fetchedSetsResp = await getCatalogSetNames({ categoryId });
  const fetchedSets = fetchedSetsResp.results;
  if (!fetchedSets || !fetchedSets.length) {
    throw new Error(
      `No sets found from getCatalogSetNames for categoryId ${categoryId}`,
    );
  }

  const existingSets = await categorySetsRepository.findByCategoryId(categoryId);
  const existingSetIds = new Set(existingSets.map((set) => set.setNameId));
  const missingSets = fetchedSets.filter(
    (set) => !existingSetIds.has(set.setNameId),
  );

  await categorySetsRepository.upsertMany(fetchedSets);

  console.log(
    `Category ${categoryId}: Found ${fetchedSets.length} total sets, ${missingSets.length} were missing from database`,
  );

  return {
    sets: fetchedSets,
    productLine: selectedProductLine,
  };
}

export async function fetchAndUpsertSetProducts(
  sets: CategorySet[],
  productLine: ProductLine,
) {
  const allSetProducts: SetProduct[] = [];

  for (const set of sets) {
    let products = await setProductsRepository.findBySetNameId(set.setNameId);

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
          if (seen.has(card.productId)) {
            continue;
          }

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

        await setProductsRepository.upsertMany(products);
      } catch {
        continue;
      }
    }

    allSetProducts.push(...products);
  }

  return allSetProducts;
}

export async function fetchAndUpsertProductsAndSkus(
  allSetProducts: SetProduct[],
  productLineId: number,
  forceRefresh: boolean = false,
) {
  console.log(
    `[fetchAndUpsertProductsAndSkus] Starting with ${
      allSetProducts.length
    } products for productLineId: ${productLineId}${
      forceRefresh ? " (force refresh)" : ""
    }`,
  );

  let productCount = 0;
  let totalSkus = 0;
  let setChanges = 0;
  let skusUpdated = 0;
  let setProductsUpdated = 0;
  let pendingInventoryUpdated = 0;
  const productConcurrency = 5;
  let productIndex = 0;

  try {
    for await (const _ of processWithConcurrency(
      allSetProducts,
      productConcurrency,
      async (product) => {
        productIndex += 1;
        if (productIndex % 10 === 0) {
          console.log(
            `[fetchAndUpsertProductsAndSkus] Processing product ${productIndex}/${allSetProducts.length}`,
          );
        }

        const existingProduct = await productsRepository.findByProductId(
          product.productId,
          productLineId,
        );

        let details: Product | null = existingProduct;

        if (forceRefresh || !details || !details.skus || !details.skus.length) {
          try {
            const fetched = await getProductDetails({ id: product.productId });
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

            const hasSetChanged =
              existingProduct && existingProduct.setId !== details.setId;

            if (hasSetChanged) {
              setChanges += 1;
              console.log(
                `[fetchAndUpsertProductsAndSkus] SET CHANGE DETECTED for product ${product.productId}: "${existingProduct.setName}" (${existingProduct.setId}) -> "${details.setName}" (${details.setId})`,
              );

              const skuUpdateCount = await skusRepository.updateSetInfoByProduct(
                product.productId,
                productLineId,
                {
                  setId: details.setId,
                  setCode: details.setCode,
                  setName: details.setName,
                },
              );
              skusUpdated += skuUpdateCount;

              const newCategorySet =
                await categorySetsRepository.findByCategoryIdAndSetNameId(
                  productLineId,
                  details.setId,
                );
              const existingSetProduct =
                await setProductsRepository.findByProductId(product.productId);

              if (existingSetProduct) {
                await setProductsRepository.upsert({
                  ...existingSetProduct,
                  setNameId: details.setId,
                  set: details.setName,
                  setAbbrv: newCategorySet?.abbreviation ?? details.setCode,
                });
                setProductsUpdated += 1;
              }

              const pendingUpdateCount =
                await pendingInventoryRepository.updateSetIdByProduct(
                  product.productId,
                  productLineId,
                  details.setId,
                );
              pendingInventoryUpdated += pendingUpdateCount;
            }

            await productsRepository.upsert(details);
          } catch (error) {
            console.warn(
              `[fetchAndUpsertProductsAndSkus] Failed to fetch product ${product.productId}:`,
              error,
            );
            return;
          }
        }

        if (!details) {
          return;
        }

        productCount += 1;
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
        const existingSkus = await skusRepository.findBySkuIds(
          details.productLineId,
          skuIds,
        );
        const existingSkuSet = new Set(existingSkus.map((sku) => sku.sku));
        const skusToInsert = skusToUpsert.filter(
          (sku) => !existingSkuSet.has(sku.sku),
        );

        if (skusToInsert.length > 0) {
          await skusRepository.insertMany(skusToInsert);
        }
      },
    )) {
      // No-op
    }

    return {
      productCount,
      totalSkus,
      setChanges,
      skusUpdated,
      setProductsUpdated,
      pendingInventoryUpdated,
    };
  } catch (error) {
    console.error(
      `[fetchAndUpsertProductsAndSkus] Error during processing:`,
      error,
    );
    throw error;
  }
}

export async function fetchAllProductLines() {
  const productLines = await getProductLines();
  if (!productLines || !productLines.length) {
    throw new Error("No product lines returned from API");
  }

  await productLinesRepository.upsertMany(productLines);

  await Promise.all(
    productLines.map(async (productLine: ProductLine) => {
      try {
        const filters = await getCategoryFilters(productLine.productLineId);
        if (filters) {
          await categoryFiltersRepository.upsert({
            categoryId: productLine.productLineId,
            ...filters,
          });
        }
      } catch (error) {
        console.warn(
          `Failed to fetch category filters for product line ${productLine.productLineId}:`,
          error,
        );
      }
    }),
  );

  return productLines;
}
