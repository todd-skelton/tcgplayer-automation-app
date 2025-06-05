import type { Route } from "./+types/home";
import { data, useFetcher, type LoaderFunctionArgs } from "react-router";
import { getAllProducts } from "~/tcgplayer/get-search-results";
import { type SetProduct } from "~/data-types/setProduct";
import { type CategorySet } from "~/data-types/categorySet";
import { getProductDetails } from "~/tcgplayer/get-product-details";
import { getCatalogSetNames } from "~/tcgplayer/get-catalog-set-names";
import type { Product } from "~/data-types/product";
import {
  categorySetsDb,
  productsDb,
  setProductsDb,
  skusDb,
} from "~/datastores";
import type { Sku } from "~/data-types/sku";
import { processWithConcurrency } from "~/processWithConcurrency";
import { Button, Box, Typography, Paper, Alert } from "@mui/material";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export async function action({ request }: LoaderFunctionArgs) {
  // Only handle fetchAllCategory3Data
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "fetchAllCategory3Data") {
    console.log("[fetchAllCategory3Data] Starting action (NeDB)");
    try {
      // 1. CATEGORY SETS
      const categoryId = 71;
      const PRODUCT_LINE = "lorcana-tcg";
      let sets: CategorySet[] = await categorySetsDb.find({ categoryId });
      if (!sets.length) {
        console.log(
          `[fetchAllCategory3Data] No sets found in NeDB for categoryId ${categoryId}, calling getCatalogSetNames`
        );
        const fetchedSetsResp = await getCatalogSetNames({ categoryId });
        const fetchedSets = fetchedSetsResp.results;
        if (!fetchedSets || !fetchedSets.length) {
          throw new Error(
            `No sets found from getCatalogSetNames for categoryId ${categoryId}`
          );
        }
        await Promise.all(
          fetchedSets.map((set: CategorySet) =>
            categorySetsDb.update({ setNameId: set.setNameId }, set, {
              upsert: true,
            })
          )
        );
        sets = fetchedSets;
        console.log(
          `[fetchAllCategory3Data] Inserted ${fetchedSets.length} sets for category ${categoryId} from getCatalogSetNames`
        );
      }
      console.log(
        `[fetchAllCategory3Data] Loaded ${sets.length} sets for category ${categoryId} (NeDB)`
      );

      // 2. SET PRODUCTS
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
                  productLineName: [PRODUCT_LINE],
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
                game: PRODUCT_LINE,
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
            console.log(
              `[Set ${setIdx + 1}/$${sets.length}] Wrote ${
                products.length
              } set products for setId ${set.setNameId} (NeDB)`
            );
          } catch (err) {
            console.error(
              `[Set ${setIdx + 1}/$${
                sets.length
              }] Error fetching set products for setId ${set.setNameId}:`,
              err
            );
            continue;
          }
        } else {
          console.log(
            `[Set ${setIdx + 1}/$${
              sets.length
            }] Set products already exist for setId ${set.setNameId} (${
              products.length
            } products)`
          );
        }
        allSetProducts.push(...products);
      }

      // 3. PRODUCTS
      let productCount = 0;
      let totalSkus = 0;
      const PRODUCT_CONCURRENCY = 100; // Configurable concurrency limit
      let prodIdx = 0;

      // Await processing of all products with concurrency
      for await (const _ of processWithConcurrency(
        allSetProducts,
        PRODUCT_CONCURRENCY,
        async (product) => {
          prodIdx += 1;
          const productId = product.productId;
          let details: Product | null = await productsDb.findOne<Product>({
            productId,
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
              await productsDb.update(
                { productId: details.productId },
                details,
                {
                  upsert: true,
                }
              );
              console.log(
                `[Product ${prodIdx}/$${allSetProducts.length}] Wrote product details for productId ${productId} with ${details.skus.length} SKUs (NeDB)`
              );
            } catch (err) {
              console.error(
                `[Product ${prodIdx}/$${allSetProducts.length}] Error fetching/writing product details for productId ${productId} (NeDB):`,
                err
              );
              return;
            }
          } else {
            console.log(
              `[Product ${prodIdx}/$${allSetProducts.length}] Product details already exist for productId ${productId} with ${details.skus.length} SKUs (NeDB)`
            );
          }
          productCount++;
          // Increment totalSkus by the number of SKUs for this product
          totalSkus += details.skus.length;
          console.log(
            `[Product ${prodIdx}/$${allSetProducts.length}] Processing productId ${productId} (${details.productName}) SKUs: ${details.skus.length})`
          );
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
          const existingSkus = await skusDb.find<Sku>({ sku: { $in: skuIds } });
          const existingSkuSet = new Set(existingSkus.map((s) => s.sku));
          const skusToInsert = skusToUpsert.filter(
            (sku) => !existingSkuSet.has(sku.sku)
          );
          if (skusToInsert.length > 0) {
            try {
              await skusDb.insert(skusToInsert);
            } catch (err) {
              console.error(`Error inserting SKUs:`, err);
            }
          }
          console.log(
            `[Product ${prodIdx + 1}/$${allSetProducts.length}] Upserted ${
              skusToUpsert.length
            } SKUs for productId ${details.productId} (NeDB)`
          );
        }
      )) {
        // No-op, just ensure all are processed
      }

      return data(
        {
          message: `Fetched and verified all sets, products, and skus for category 3 using NeDB. Sets: ${sets.length}, set-products: ${allSetProducts.length}, products: ${productCount}, skus: ${totalSkus}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      console.error("[fetchAllCategory3Data] Error (NeDB):", error);
      return data({ error: String(error) }, { status: 500 });
    }
  }
  return data({ error: "Unknown action" }, { status: 400 });
}

export default function Home() {
  const allCategory3DataFetcher = useFetcher<typeof action>();

  return (
    <Box sx={{ p: 3 }}>
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h4" gutterBottom>
          Fetch & Verify All Category 3 Data
        </Typography>
        <allCategory3DataFetcher.Form method="post">
          <input
            type="hidden"
            name="actionType"
            value="fetchAllCategory3Data"
          />
          <Button type="submit" variant="contained" color="primary">
            Fetch & Verify All Category 3 Data
          </Button>
        </allCategory3DataFetcher.Form>
      </Paper>
      {allCategory3DataFetcher.data &&
      "message" in allCategory3DataFetcher.data ? (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="h6">All Category 3 Data Fetch Result</Typography>
          <pre>{allCategory3DataFetcher.data.message}</pre>
        </Paper>
      ) : allCategory3DataFetcher.data &&
        "error" in allCategory3DataFetcher.data ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography variant="h6">Error</Typography>
          <pre style={{ margin: 0 }}>{allCategory3DataFetcher.data.error}</pre>
        </Alert>
      ) : null}
    </Box>
  );
}
