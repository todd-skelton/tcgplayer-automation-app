import type { Route } from "./+types/home";
import { data, useFetcher, type LoaderFunctionArgs } from "react-router";
import { getSetCards } from "~/tcgplayer/get-set-cards";
import { type SetProduct } from "~/data-types/setProduct";
import { type CategorySet } from "~/data-types/categorySet";
import { getProductDetails } from "~/tcgplayer/get-product-details";
import type { Sku } from "~/tcgplayer/get-product-details";
import pLimit from "p-limit";
import path from "path";
import Datastore from "nedb-promises";
import { getCatalogSetNames } from "~/tcgplayer/get-catalog-set-names";

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
    // Setup NeDB databases
    const dataDir = path.resolve(process.cwd(), "data");
    const categorySetsDb = Datastore.create({
      filename: path.join(dataDir, "categorySets.db"),
      autoload: true,
    });
    const setProductsDb = Datastore.create({
      filename: path.join(dataDir, "setProducts.db"),
      autoload: true,
    });
    const productsDb = Datastore.create({
      filename: path.join(dataDir, "products.db"),
      autoload: true,
    });
    const skusDb = Datastore.create({
      filename: path.join(dataDir, "skus.db"),
      autoload: true,
    });

    try {
      console.log("[fetchAllCategory3Data] Starting action (NeDB)");
      // Read sets from categorySetsDb (categoryId = 3)
      const categoryId = 3;
      const sets: CategorySet[] = await categorySetsDb.find({ categoryId });
      if (!sets.length) {
        // If no sets found, fetch from network and insert
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
        // Insert fetched sets into NeDB
        await Promise.all(
          fetchedSets.map((set: CategorySet) =>
            categorySetsDb.update({ setNameId: set.setNameId }, set, {
              upsert: true,
            })
          )
        );
        console.log(
          `[fetchAllCategory3Data] Inserted ${fetchedSets.length} sets for category ${categoryId} from getCatalogSetNames`
        );
        // Re-query from NeDB
        sets.splice(0, sets.length, ...fetchedSets);
      }
      console.log(
        `[fetchAllCategory3Data] Loaded ${sets.length} sets for category ${categoryId} (NeDB)`
      );
      let totalSetProducts = 0;
      let totalProducts = 0;
      let totalSkus = 0;
      const networkLimit = pLimit(5); // Limit to 1 concurrent network requests
      await Promise.all(
        sets.map(async (set: CategorySet, setIdx) => {
          try {
            const setId = set.setNameId;
            // Try to get set-products from NeDB
            let products: SetProduct[] = await setProductsDb.find({
              setNameId: setId,
            });
            if (products.length) {
              console.log(
                `[Set ${setIdx + 1}/$${
                  sets.length
                }] Set products already exist for setId ${setId} ($${
                  products.length
                } products)`
              );
            } else {
              // Fetch set cards
              console.log(
                `[Set ${setIdx + 1}/$${
                  sets.length
                }] Fetching set cards for setId ${setId}`
              );
              try {
                // Limit getSetCards network call
                const cardsResp = await networkLimit(async () => {
                  await delay(1000);
                  console.log(
                    `[Set ${setIdx + 1}/$${
                      sets.length
                    }] Calling getSetCards for setId ${setId}`
                  );
                  const resp = await getSetCards({ setId });
                  return resp;
                });
                const seen = new Set<number>();
                products = [];
                if (cardsResp.result) {
                  for (const card of cardsResp.result) {
                    if (seen.has(card.productID)) continue;
                    seen.add(card.productID);
                    products.push({
                      setNameId: setId,
                      productID: card.productID,
                      game: card.game,
                      number: card.number,
                      productName: card.productName,
                      rarity: card.rarity,
                      set: card.set,
                      setAbbrv: card.setAbbrv,
                      type: card.type,
                    });
                  }
                }
                // Insert all set-products into NeDB
                await Promise.all(
                  products.map((prod) =>
                    setProductsDb.update({ productID: prod.productID }, prod, {
                      upsert: true,
                    })
                  )
                );
                totalSetProducts++;
                console.log(
                  `[Set ${setIdx + 1}/$${sets.length}] Wrote $${
                    products.length
                  } set products for setId ${setId} (NeDB)`
                );
              } catch (setCardErr) {
                console.error(
                  `[Set ${setIdx + 1}/$${
                    sets.length
                  }] Error fetching set cards for setId ${setId}:`,
                  setCardErr
                );
                return; // Skip to next set
              }
            }
            // For each product, fetch and save product details and SKUs (skip if exists)
            for (let prodIdx = 0; prodIdx < products.length; prodIdx++) {
              const product = products[prodIdx];
              try {
                const productId = product.productID;
                // Try to get product details from NeDB
                let details = (await productsDb.findOne({
                  productId,
                })) as any;
                let needWrite = false;
                if (details && details.skus) {
                  // Check if all SKUs exist
                  const skus: Sku[] = details.skus ?? [];
                  let missingSku = false;
                  for (const sku of skus) {
                    const skuDoc = (await skusDb.findOne({
                      sku: sku.sku,
                    })) as any;
                    if (!skuDoc) {
                      missingSku = true;
                      break;
                    }
                  }
                  if (!skus.length || missingSku) {
                    needWrite = true;
                    console.log(
                      `[Product ${prodIdx + 1}/$${
                        products.length
                      }] Product ${productId} missing SKUs or details, will fetch (NeDB)`
                    );
                  } else {
                    // All SKUs exist, skip
                    continue;
                  }
                } else {
                  needWrite = true;
                  console.log(
                    `[Product ${prodIdx + 1}/$${
                      products.length
                    }] Product ${productId} details not found, will fetch (NeDB)`
                  );
                }
                if (needWrite) {
                  try {
                    const fetched = await networkLimit(async () => {
                      await delay(1000);
                      console.log(
                        `[Product ${prodIdx + 1}/$${
                          products.length
                        }] Calling getProductDetails for productId ${productId}`
                      );
                      const resp = await getProductDetails({ id: productId });
                      return resp;
                    });
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
                      sellerListable: fetched.sellerListable,
                    };
                    await productsDb.update(
                      { productId: details.productId },
                      details,
                      { upsert: true }
                    );
                    totalProducts++;
                    console.log(
                      `[Product ${prodIdx + 1}/$${
                        products.length
                      }] Wrote product details for productId ${productId} with $${
                        details.skus.length
                      } SKUs (NeDB)`
                    );
                    // Save SKUs in parallel
                    await Promise.all(
                      (details.skus ?? []).map((sku: Sku, skuIdx: number) =>
                        skusDb
                          .update(
                            { sku: sku.sku },
                            {
                              ...sku,
                              productTypeName: details.productTypeName,
                              rarityName: details.rarityName,
                              sealed: details.sealed,
                              productName: details.productName,
                              setId: details.setId,
                              setCode: details.setCode,
                              productId: details.productId,
                              setName: details.setName,
                              sellerListable: details.sellerListable,
                              productLineId: details.productLineId,
                              productStatusId: details.productStatusId,
                              productLineName: details.productLineName,
                            },
                            { upsert: true }
                          )
                          .then(() => {
                            totalSkus++;
                            console.log(
                              `[SKU ${skuIdx + 1}/$${
                                details.skus.length
                              }] Wrote SKU ${
                                sku.sku
                              } for productId ${productId} (NeDB)`
                            );
                          })
                          .catch((skuErr) => {
                            console.error(
                              `[SKU ${skuIdx + 1}/$${
                                details.skus.length
                              }] Error writing SKU ${
                                sku.sku
                              } for productId ${productId} (NeDB):`,
                              skuErr
                            );
                          })
                      )
                    );
                  } catch (prodDetailsErr) {
                    console.error(
                      `[Product ${prodIdx + 1}/$${
                        products.length
                      }] Error fetching/writing product details for productId ${productId} (NeDB):`,
                      prodDetailsErr
                    );
                  }
                }
              } catch (productErr) {
                console.error(
                  `[Product ${prodIdx + 1}/$${
                    products.length
                  }] Error processing productId ${product.productID} (NeDB):`,
                  productErr
                );
              }
            }
          } catch (setErr) {
            console.error(
              `[Set ${setIdx + 1}/$${sets.length}] Error processing setId ${
                set.setNameId
              } (NeDB):`,
              setErr
            );
          }
        })
      );
      console.log(
        `[fetchAllCategory3Data] Done. New set-products: ${totalSetProducts}, new products: ${totalProducts}, new skus: ${totalSkus} (NeDB)`
      );
      return data(
        {
          message: `Fetched and verified all sets, products, and skus for category 3 using NeDB. New set-products: ${totalSetProducts}, new products: ${totalProducts}, new skus: ${totalSkus}.`,
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

// Utility function to delay for a given ms
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Home() {
  const allCategory3DataFetcher = useFetcher<typeof action>();

  return (
    <div>
      <allCategory3DataFetcher.Form method="post">
        <input type="hidden" name="actionType" value="fetchAllCategory3Data" />
        <button type="submit">Fetch &amp; Verify All Category 3 Data</button>
      </allCategory3DataFetcher.Form>
      {allCategory3DataFetcher.data &&
      "message" in allCategory3DataFetcher.data ? (
        <div>
          <h2>All Category 3 Data Fetch Result</h2>
          <pre>{allCategory3DataFetcher.data.message}</pre>
        </div>
      ) : allCategory3DataFetcher.data &&
        "error" in allCategory3DataFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{allCategory3DataFetcher.data.error}</pre>
        </div>
      ) : null}
    </div>
  );
}
