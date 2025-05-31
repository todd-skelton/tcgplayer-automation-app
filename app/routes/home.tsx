import type { Route } from "./+types/home";
import { data, useFetcher, type LoaderFunctionArgs } from "react-router";
import { getSetCards } from "~/tcgplayer/get-set-cards";
import { type SetProduct } from "~/data-types/setProduct";
import { type CategorySet } from "~/data-types/categorySet";
import { getProductDetails } from "~/tcgplayer/get-product-details";
import type { Sku } from "~/tcgplayer/get-product-details";
import pLimit from "p-limit";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export async function action({ request }: LoaderFunctionArgs) {
  // Dynamically import Node.js modules to avoid Vite SSR issues
  const path = await import("path");
  const fs = await import("fs/promises");

  // Add file write limiter
  const fileLimit = pLimit(10); // Limit to 10 concurrent file operations

  // Only handle fetchAllCategory3Data
  const formData = await request.formData();
  const actionType = formData.get("actionType");
  if (actionType === "fetchAllCategory3Data") {
    try {
      console.log("[fetchAllCategory3Data] Starting action");
      // Use sets from data/category-sets/3.json only
      const categoryId = 3;
      const categorySetsDir = path.resolve(process.cwd(), "data/category-sets");
      const setProductsDir = path.resolve(process.cwd(), "data/set-products");
      const productsDir = path.resolve(process.cwd(), "data/products");
      const skusDir = path.resolve(process.cwd(), "data/skus");
      await Promise.all([
        fileLimit(() => fs.mkdir(categorySetsDir, { recursive: true })),
        fileLimit(() => fs.mkdir(setProductsDir, { recursive: true })),
        fileLimit(() => fs.mkdir(productsDir, { recursive: true })),
        fileLimit(() => fs.mkdir(skusDir, { recursive: true })),
      ]);
      console.log("[fetchAllCategory3Data] Ensured data directories exist");
      // Read sets from categorySetsDir/categoryId.json
      const categorySetsFile = path.join(categorySetsDir, `${categoryId}.json`);
      const sets: CategorySet[] = JSON.parse(
        await fileLimit(() => fs.readFile(categorySetsFile, "utf-8"))
      );
      console.log(
        `[fetchAllCategory3Data] Loaded ${sets.length} sets for category ${categoryId}`
      );
      let totalSetProducts = 0;
      let totalProducts = 0;
      let totalSkus = 0;
      const networkLimit = pLimit(5); // Limit to 5 concurrent network requests
      await Promise.all(
        sets.map(async (set: CategorySet, setIdx) => {
          const setId = set.setNameId;
          const setProductsFile = path.join(setProductsDir, `${setId}.json`);
          let products: SetProduct[] = [];
          try {
            await fileLimit(() => fs.access(setProductsFile));
            products = JSON.parse(
              await fileLimit(() => fs.readFile(setProductsFile, "utf-8"))
            );
            console.log(
              `[Set ${setIdx + 1}/$${
                sets.length
              }] Set products already exist for setId ${setId} ($${
                products.length
              } products)`
            );
          } catch {
            // Fetch set cards
            console.log(
              `[Set ${setIdx + 1}/$${
                sets.length
              }] Fetching set cards for setId ${setId}`
            );
            // Limit getSetCards network call
            const cardsResp = await networkLimit(() => getSetCards({ setId }));
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
            await fileLimit(() =>
              fs.writeFile(
                setProductsFile,
                JSON.stringify(products, null, 2),
                "utf-8"
              )
            );
            totalSetProducts++;
            console.log(
              `[Set ${setIdx + 1}/$${sets.length}] Wrote $${
                products.length
              } set products for setId ${setId}`
            );
          }
          // For each product, fetch and save product details and SKUs (skip if exists)
          await Promise.all(
            products.map(async (product: SetProduct, prodIdx) => {
              const productId = product.productID;
              const productFile = path.join(productsDir, `${productId}.json`);
              let details: {
                productTypeName: string;
                rarityName: string;
                sealed: boolean;
                productName: string;
                setId: number;
                setCode: string;
                productId: number;
                setName: string;
                productLineId: number;
                productStatusId: number;
                productLineName: string;
                skus: Sku[];
                sellerListable?: boolean;
              };
              let needWrite = false;
              try {
                await fileLimit(() => fs.access(productFile));
                details = JSON.parse(
                  await fileLimit(() => fs.readFile(productFile, "utf-8"))
                );
                // Check if all SKUs exist
                const skus: Sku[] = details.skus ?? [];
                const missingSku = await Promise.any(
                  skus.map(async (sku: Sku) => {
                    try {
                      await fileLimit(() =>
                        fs.access(path.join(skusDir, `${sku.sku}.json`))
                      );
                      return false;
                    } catch {
                      return true;
                    }
                  })
                ).catch(() => false);
                if (!skus.length || missingSku) {
                  needWrite = true;
                  console.log(
                    `[Product ${prodIdx + 1}/$${
                      products.length
                    }] Product ${productId} missing SKUs or details, will fetch`
                  );
                } else {
                  // All SKUs exist, skip
                  return;
                }
              } catch {
                needWrite = true;
                console.log(
                  `[Product ${prodIdx + 1}/$${
                    products.length
                  }] Product ${productId} details not found, will fetch`
                );
              }
              if (needWrite) {
                // Limit getProductDetails network call
                const fetched = await networkLimit(() =>
                  getProductDetails({ id: productId })
                );
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
                await fileLimit(() =>
                  fs.writeFile(
                    productFile,
                    JSON.stringify(details, null, 2),
                    "utf-8"
                  )
                );
                totalProducts++;
                console.log(
                  `[Product ${prodIdx + 1}/$${
                    products.length
                  }] Wrote product details for productId ${productId} with $${
                    details.skus.length
                  } SKUs`
                );
                // Save SKUs in parallel
                await Promise.all(
                  details.skus.map((sku: Sku, skuIdx) =>
                    fileLimit(() =>
                      fs
                        .writeFile(
                          path.join(skusDir, `${sku.sku}.json`),
                          JSON.stringify(
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
                            null,
                            2
                          ),
                          "utf-8"
                        )
                        .then(() => {
                          totalSkus++;
                          console.log(
                            `[SKU ${skuIdx + 1}/$${
                              details.skus.length
                            }] Wrote SKU ${sku.sku} for productId ${productId}`
                          );
                        })
                    )
                  )
                );
              }
            })
          );
        })
      );
      console.log(
        `[fetchAllCategory3Data] Done. New set-products: ${totalSetProducts}, new products: ${totalProducts}, new skus: ${totalSkus}`
      );
      return data(
        {
          message: `Fetched and verified all sets, products, and skus for category 3 using category-sets. New set-products: ${totalSetProducts}, new products: ${totalProducts}, new skus: ${totalSkus}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      console.error("[fetchAllCategory3Data] Error:", error);
      return data({ error: String(error) }, { status: 500 });
    }
  }
  return data({ error: "Unknown action" }, { status: 400 });
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
