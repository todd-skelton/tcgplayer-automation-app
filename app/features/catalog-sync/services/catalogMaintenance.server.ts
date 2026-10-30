import {
  categorySetsRepository,
  productLinesRepository,
  productsRepository,
  setProductsRepository,
  skusRepository,
} from "~/core/db";
import { getAllProducts } from "~/integrations/tcgplayer/client/get-search-results.server";
import {
  fetchAllProductLines,
  fetchAndUpsertCategorySets,
  fetchAndUpsertProductsAndSkus,
  fetchAndUpsertSetProducts,
} from "~/routes/home.server";
import type { SetProduct } from "~/shared/data-types/setProduct";
import { describeCatalogSync } from "../domain/catalogSyncSummary";
import { syncNewCatalogProducts } from "./syncNewCatalogProducts.server";

/** What a catalog job answers: what it did, or why it did not, with the HTTP status to send. */
export type CatalogMaintenanceAnswer = {
  status: number;
  body: { message?: string; error?: string };
};

// The Data Management screen's jobs, each named by `actionType` and read from its fields: the
// product lines, a product line's new products or every product, one product, or one set, all
// fetched from TCGplayer. Both the React screen's form and the Corten screen's JSON post run them.
export async function runCatalogMaintenance(
  field: (name: string) => string | null,
): Promise<CatalogMaintenanceAnswer> {
  const actionType = field("actionType");

  if (actionType === "syncNewProducts") {
    try {
      const categoryId = Number(field("categoryId"));

      if (!categoryId) {
        return { status: 400, body: { error: "Missing product line" } };
      }

      const result = await syncNewCatalogProducts(categoryId);
      return { status: 200, body: { message: describeCatalogSync(result) } };
    } catch (error) {
      console.error("[syncNewProducts] Error:", error);
      return { status: 500, body: { error: String(error) } };
    }
  }

  if (actionType === "fetchAllCategory3Data") {
    try {
      const categoryId = Number(field("categoryId"));
      const { sets, productLine } = await fetchAndUpsertCategorySets(categoryId);
      const allSetProducts = await fetchAndUpsertSetProducts(sets, productLine);
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        allSetProducts,
        productLine.productLineId,
      );

      return { status: 200, body: {
          message: `Fetched and verified all sets, products, and skus for category ${categoryId} using PostgreSQL. Sets: ${sets.length}, set-products: ${allSetProducts.length}, products: ${productCount}, skus: ${totalSkus}.`,
        } };
    } catch (error) {
      return { status: 500, body: { error: String(error) } };
    }
  }

  if (actionType === "fetchAllProductLines") {
    try {
      const productLines = await fetchAllProductLines();
      return { status: 200, body: {
          message: `Fetched and upserted ${productLines.length} product lines and their category filters.`,
        } };
    } catch (error) {
      console.error("[fetchAllProductLines] Error:", error);
      return { status: 500, body: { error: String(error) } };
    }
  }

  if (actionType === "updateProductAndSkus") {
    try {
      const productId = Number(field("productId"));
      const productLineId = field("productLineId")
        ? Number(field("productLineId"))
        : null;

      if (!productId) {
        return { status: 400, body: { error: "Missing or invalid productId" } };
      }

      if (!productLineId) {
        return { status: 400, body: { error: "Product Line ID is required for optimized performance" } };
      }

      const existingProduct = await productsRepository.findByProductId(
        productId,
        productLineId,
      );

      if (!existingProduct) {
        return { status: 404, body: {
            error: `Product with ID ${productId} not found in product line ${productLineId}`,
          } };
      }

      const dummySetProduct = { productId } as SetProduct;
      const result = await fetchAndUpsertProductsAndSkus(
        [dummySetProduct],
        existingProduct.productLineId,
        true,
      );

      let message = `Updated product and skus for productId ${productId}. Products: ${result.productCount}, skus: ${result.totalSkus}.`;
      if (result.setChanges > 0) {
        message += ` Set reclassification detected and corrected: ${result.skusUpdated} SKUs updated, ${result.setProductsUpdated} SetProducts updated, ${result.pendingInventoryUpdated} PendingInventory entries updated.`;
      }

      return { status: 200, body: { message } };
    } catch (error) {
      return { status: 500, body: { error: String(error) } };
    }
  }

  if (actionType === "fetchSetProductsAndSkus") {
    try {
      const setName = field("setName") as string;
      const productLineName = field("productLineName") as string;
      const deleteExisting = field("deleteExistingSet") === "on";

      if (!setName) {
        return { status: 400, body: { error: "Missing set name" } };
      }

      if (!productLineName) {
        return { status: 400, body: { error: "Missing product line name" } };
      }

      if (deleteExisting) {
        const productLineForDelete = await productLinesRepository.findByUrlName(
          productLineName,
        );

        if (!productLineForDelete) {
          return { status: 400, body: { error: `Product line not found: ${productLineName}` } };
        }

        const categorySet =
          await categorySetsRepository.findByCategoryIdAndUrlName(
            productLineForDelete.productLineId,
            setName,
          );

        if (categorySet) {
          await setProductsRepository.removeBySetNameId(categorySet.setNameId);
          await productsRepository.removeBySetId(
            categorySet.setNameId,
            productLineForDelete.productLineId,
          );
          await skusRepository.removeBySetId(
            categorySet.setNameId,
            productLineForDelete.productLineId,
          );
        }
      }

      const productLine = await productLinesRepository.findByUrlName(
        productLineName,
      );

      if (!productLine) {
        return { status: 400, body: { error: `Product line not found: ${productLineName}` } };
      }

      let categorySet = await categorySetsRepository.findByCategoryIdAndUrlName(
        productLine.productLineId,
        setName,
      );

      if (!categorySet) {
        try {
          await fetchAndUpsertCategorySets(productLine.productLineId);
          categorySet = await categorySetsRepository.findByCategoryIdAndUrlName(
            productLine.productLineId,
            setName,
          );
        } catch (error) {
          console.warn(
            `Could not fetch sets for category ${productLine.productLineId}:`,
            error,
          );
        }
      }

      const setProducts: SetProduct[] = [];

      try {
        const searchResults = await getAllProducts({
          size: 1000,
          filters: {
            term: {
              productLineName: [productLineName],
              setName: [setName],
            },
          },
          sort: { field: "product-sorting-name", order: "asc" },
        });

        if (!searchResults || !searchResults.length) {
          return { status: 404, body: {
              error: `No products found for set "${setName}" in product line "${productLineName}". Please check the set name and product line.`,
            } };
        }

        const seen = new Set<number>();
        for (const card of searchResults) {
          if (seen.has(card.productId)) {
            continue;
          }

          seen.add(card.productId);
          setProducts.push({
            setNameId: categorySet?.setNameId || 0,
            productId: card.productId,
            game: productLineName,
            number: card.customAttributes?.number ?? "",
            productName: card.productName,
            rarity: card.rarityName,
            set: card.setName,
            setAbbrv: card.setUrlName,
            type: card.customAttributes?.cardType?.join(", ") ?? "",
          });
        }

        if (setProducts.length > 0 && setProducts[0].setNameId === 0) {
          console.warn(
            `Warning: setNameId is 0 for set "${setName}" in product line "${productLineName}". CategorySet found:`,
            categorySet,
          );
        }

        await setProductsRepository.upsertMany(setProducts);
      } catch (error) {
        console.error("[API] Failed to search for products:", error);
        return { status: 500, body: { error: `Failed to search for products: ${String(error)}` } };
      }

      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        setProducts,
        productLine.productLineId,
      );

      return { status: 200, body: {
          message: `Fetched and verified products and SKUs for set "${setName}" in product line "${productLineName}". Set products: ${setProducts.length}, products: ${productCount}, SKUs: ${totalSkus}.`,
        } };
    } catch (error) {
      return { status: 500, body: { error: String(error) } };
    }
  }

  return { status: 400, body: { error: "Unknown action" } };
}
