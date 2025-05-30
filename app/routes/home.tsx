import type { Route } from "./+types/home";
import { data, useFetcher, type LoaderFunctionArgs } from "react-router";
import { getCatalogSetNames } from "~/tcgplayer/get-catalog-set-names";
import path from "path";
import fs from "fs/promises";
import { getSetCards } from "~/tcgplayer/get-set-cards";
import { type SetProduct } from "~/data/setProduct";
import { type CategorySet } from "~/data/categorySet";
import { getProductDetails } from "~/tcgplayer/get-product-details";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export async function action({ request }: LoaderFunctionArgs) {
  const formData = await request.formData();
  const actionType = formData.get("actionType");
  if (actionType === "fetchSets") {
    try {
      // 1. Get all set names for category 3
      const setsResponse = await getCatalogSetNames({ categoryId: 3 });
      const sets = setsResponse.results;

      // 2. Ensure output directory exists
      const dir = path.resolve(process.cwd(), "app/tcgplayer/data/sets");
      await fs.mkdir(dir, { recursive: true });

      let written = 0;
      let skipped = 0;

      for (const set of sets) {
        const setObj = {
          setNameId: set.setNameId,
          categoryId: set.categoryId,
          name: set.name,
          cleanSetName: set.cleanSetName,
          abbreviation: set.abbreviation,
          releaseDate: set.releaseDate,
          isSupplemental: set.isSupplemental,
          active: set.active,
        };
        const filePath = path.join(dir, `${set.setNameId}.json`);
        try {
          await fs.access(filePath);
          skipped++;
          continue; // File exists, skip
        } catch {
          // File does not exist, proceed
        }
        await fs.writeFile(filePath, JSON.stringify(setObj, null, 2), "utf-8");
        written++;
      }

      return data(
        {
          message: `Fetched and saved ${written} sets. Skipped ${skipped} existing files.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  } else if (actionType === "fetchCategorySets") {
    try {
      const categoryId = 3;
      const setsResponse = await getCatalogSetNames({ categoryId });
      const sets = setsResponse.results.map((set) => ({
        setNameId: set.setNameId,
        categoryId: set.categoryId,
        name: set.name,
        cleanSetName: set.cleanSetName,
        abbreviation: set.abbreviation,
        releaseDate: set.releaseDate,
        isSupplemental: set.isSupplemental,
        active: set.active,
      }));
      const dir = path.resolve(process.cwd(), "app/data/category-sets");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${categoryId}.json`);
      await fs.writeFile(filePath, JSON.stringify(sets, null, 2), "utf-8");
      return data(
        {
          message: `Fetched and saved ${sets.length} category sets to ${filePath}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  } else if (actionType === "fetchCategorySetProducts") {
    try {
      const categorySetsDir = path.resolve(
        process.cwd(),
        "app/data/category-sets"
      );
      const setProductsDir = path.resolve(
        process.cwd(),
        "app/data/set-products"
      );
      await fs.mkdir(setProductsDir, { recursive: true });

      const files = await fs.readdir(categorySetsDir);
      let totalSets = 0;
      let totalProducts = 0;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const sets: CategorySet[] = JSON.parse(
          await fs.readFile(path.join(categorySetsDir, file), "utf-8")
        );
        for (const set of sets) {
          const setId = set.setNameId;
          const outFile = path.join(setProductsDir, `${setId}.json`);
          try {
            await fs.access(outFile);
            continue; // Already exists, skip
          } catch {
            // Not found, proceed
          }
          const cardsResp = await getSetCards({ setId });
          // Map and filter duplicates by productID
          const seen = new Set<number>();
          const products: SetProduct[] = [];
          if (!cardsResp.result) {
            console.warn(`No cards found for set ${setId}`);
            continue; // Skip if no cards found
          }
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
          await fs.writeFile(
            outFile,
            JSON.stringify(products, null, 2),
            "utf-8"
          );
          totalSets++;
          totalProducts += products.length;
        }
      }
      return data(
        {
          message: `Fetched and saved products for ${totalSets} sets. Total unique products: ${totalProducts}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  } else if (actionType === "fetchAllProductDetails") {
    try {
      const setProductsDir = path.resolve(
        process.cwd(),
        "app/data/set-products"
      );
      const productsDir = path.resolve(process.cwd(), "app/data/products");
      const skusDir = path.resolve(process.cwd(), "app/data/skus");
      await fs.mkdir(productsDir, { recursive: true });
      await fs.mkdir(skusDir, { recursive: true });

      const setFiles = await fs.readdir(setProductsDir);
      let totalProducts = 0;
      let totalSkus = 0;

      // Process each set file in parallel
      await Promise.all(
        setFiles
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const products = JSON.parse(
              await fs.readFile(path.join(setProductsDir, file), "utf-8")
            );
            for (const product of products) {
              const productId = product.productID;
              try {
                // Check if product file exists
                const productFile = path.join(productsDir, `${productId}.json`);
                await fs.access(productFile);

                // Read product file to get SKUs
                const productData = JSON.parse(
                  await fs.readFile(productFile, "utf-8")
                );
                const skus = productData.skus ?? [];

                // Check if all SKUs exist
                const missingSku = await Promise.any(
                  skus.map(async (sku: any) => {
                    try {
                      await fs.access(path.join(skusDir, `${sku.sku}.json`));
                      return false;
                    } catch {
                      return true;
                    }
                  })
                ).catch(() => false);

                if (!skus.length || missingSku) {
                  // Some SKUs missing, do not skip
                } else {
                  continue; // All SKUs exist, skip
                }
              } catch {
                // Product file or SKUs missing, do not skip
              }
              // Log starting the fetch for this product
              console.log(`Fetching details for product ${productId}...`);
              // Fetch product details
              const details = await getProductDetails({ id: productId });
              // log the details along with set and product information and sku count
              console.log(
                `Fetched details for product ${productId} (${details.productName}) with ${details.skus.length} SKUs from set ${product.set}`
              );
              // Map to Product type
              const mappedProduct = {
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
                skus: details.skus,
              };
              await fs.writeFile(
                path.join(productsDir, `${productId}.json`),
                JSON.stringify(mappedProduct, null, 2),
                "utf-8"
              );
              totalProducts++;
              // Save each SKU in parallel
              await Promise.all(
                details.skus.map((sku) =>
                  fs.writeFile(
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
                )
              );
              totalSkus += details.skus.length;
              // Log completion for this product
              console.log(
                `Completed saving product ${productId} (${details.productName}) with ${details.skus.length} SKUs.`
              );
            }
          })
      );

      return data(
        {
          message: `Fetched and saved ${totalProducts} products and ${totalSkus} skus.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  }
  return data({ error: "Unknown action" }, { status: 400 });
}

export default function Home() {
  const setFetcher = useFetcher<typeof action>();
  const productDetailsFetcher = useFetcher<typeof action>();
  const setsFetcher = useFetcher<typeof action>();
  const categorySetsFetcher = useFetcher<typeof action>();
  const categorySetProductsFetcher = useFetcher<typeof action>(); // <-- Add this line
  const allProductDetailsFetcher = useFetcher<typeof action>();

  return (
    <div>
      <setsFetcher.Form method="post">
        <input type="hidden" name="actionType" value="fetchSets" />
        <button type="submit">Fetch & Save Sets</button>
      </setsFetcher.Form>
      {/* New Button for Category Sets */}
      <categorySetsFetcher.Form method="post">
        <input type="hidden" name="actionType" value="fetchCategorySets" />
        <button type="submit">Fetch & Save Category Sets</button>
      </categorySetsFetcher.Form>
      {/* New Button for Category Set Products */}
      <categorySetProductsFetcher.Form method="post">
        <input
          type="hidden"
          name="actionType"
          value="fetchCategorySetProducts"
        />
        <button type="submit">Fetch & Save Category Set Products</button>
      </categorySetProductsFetcher.Form>
      {/* Button for All Product Details */}
      <allProductDetailsFetcher.Form method="post">
        <input type="hidden" name="actionType" value="fetchAllProductDetails" />
        <button type="submit">Fetch & Save All Product Details</button>
      </allProductDetailsFetcher.Form>
      {setFetcher.data && "message" in setFetcher.data ? (
        <div>
          <h2>Set Cards Fetch Result</h2>
          <pre>{setFetcher.data.message}</pre>
        </div>
      ) : setFetcher.data && "error" in setFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{setFetcher.data.error}</pre>
        </div>
      ) : null}
      {productDetailsFetcher.data && "message" in productDetailsFetcher.data ? (
        <div>
          <h2>Product Details Fetch Result</h2>
          <pre>{productDetailsFetcher.data.message}</pre>
        </div>
      ) : productDetailsFetcher.data &&
        "error" in productDetailsFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{productDetailsFetcher.data.error}</pre>
        </div>
      ) : null}
      {setsFetcher.data && "message" in setsFetcher.data ? (
        <div>
          <h2>Sets Fetch Result</h2>
          <pre>{setsFetcher.data.message}</pre>
        </div>
      ) : setsFetcher.data && "error" in setsFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{setsFetcher.data.error}</pre>
        </div>
      ) : null}
      {/* Category Sets Fetch Result */}
      {categorySetsFetcher.data && "message" in categorySetsFetcher.data ? (
        <div>
          <h2>Category Sets Fetch Result</h2>
          <pre>{categorySetsFetcher.data.message}</pre>
        </div>
      ) : categorySetsFetcher.data && "error" in categorySetsFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{categorySetsFetcher.data.error}</pre>
        </div>
      ) : null}
      {/* Category Set Products Fetch Result */}
      {categorySetProductsFetcher.data &&
      "message" in categorySetProductsFetcher.data ? (
        <div>
          <h2>Category Set Products Fetch Result</h2>
          <pre>{categorySetProductsFetcher.data.message}</pre>
        </div>
      ) : categorySetProductsFetcher.data &&
        "error" in categorySetProductsFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{categorySetProductsFetcher.data.error}</pre>
        </div>
      ) : null}
      {/* All Product Details Fetch Result */}
      {allProductDetailsFetcher.data &&
      "message" in allProductDetailsFetcher.data ? (
        <div>
          <h2>All Product Details Fetch Result</h2>
          <pre>{allProductDetailsFetcher.data.message}</pre>
        </div>
      ) : allProductDetailsFetcher.data &&
        "error" in allProductDetailsFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{allProductDetailsFetcher.data.error}</pre>
        </div>
      ) : null}
    </div>
  );
}
