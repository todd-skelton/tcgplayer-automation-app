import type { Route } from "./+types/home";
import {
  data,
  useFetcher,
  type LoaderFunctionArgs,
  useLoaderData,
  Link,
} from "react-router";
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
  productLinesDb,
  categoryFiltersDb,
} from "~/datastores";
import type { Sku } from "~/data-types/sku";
import { processWithConcurrency } from "~/processWithConcurrency";
import {
  Button,
  Box,
  Typography,
  Paper,
  Alert,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  Stack,
} from "@mui/material";
import { getProductLines } from "~/tcgplayer/get-product-lines";
import { getCategoryFilters } from "~/tcgplayer/get-category-filters";
import { getSetCards } from "~/tcgplayer/get-set-cards";
import type { ProductLine } from "~/data-types/productLine";
import { useEffect, useState } from "react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export async function action({ request }: LoaderFunctionArgs) {
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "fetchAllCategory3Data") {
    try {
      const categoryId = Number(formData.get("categoryId"));
      // 1. CATEGORY SETS
      const { sets, productLine } = await fetchAndUpsertCategorySets(
        categoryId
      );
      // 2. SET PRODUCTS
      const allSetProducts = await fetchAndUpsertSetProducts(sets, productLine);

      // 3. PRODUCTS
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        allSetProducts
      );

      return data(
        {
          message: `Fetched and verified all sets, products, and skus for category 3 using NeDB. Sets: ${sets.length}, set-products: ${allSetProducts.length}, products: ${productCount}, skus: ${totalSkus}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  }

  if (actionType === "fetchAllProductLines") {
    try {
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
            await categoryFiltersDb.update(
              { categoryId: pl.productLineId },
              { categoryId: pl.productLineId, ...filters },
              { upsert: true }
            );
          } catch (err) {
            console.error(
              `Error fetching/storing category filters for productLineId ${pl.productLineId}:`,
              err
            );
          }
        })
      );
      return data(
        {
          message: `Fetched and upserted ${productLines.length} product lines and their category filters.`,
        },
        { status: 200 }
      );
    } catch (error) {
      console.error("[fetchAllProductLines] Error:", error);
      return data({ error: String(error) }, { status: 500 });
    }
  }

  if (actionType === "updateProductAndSkus") {
    try {
      const productId = Number(formData.get("productId"));
      if (!productId) {
        return data({ error: "Missing or invalid productId" }, { status: 400 });
      }
      // Use the same logic as fetchAndUpsertProductsAndSkus but for a single product
      const dummySetProduct = { productId } as SetProduct;
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus([
        dummySetProduct,
      ]);
      return data(
        {
          message: `Updated product and skus for productId ${productId}. Products: ${productCount}, skus: ${totalSkus}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  }

  if (actionType === "fetchSetProductsAndSkus") {
    try {
      const setName = formData.get("setName") as string;
      const productLineName = formData.get("productLineName") as string;
      if (!setName) {
        return data({ error: "Missing set name" }, { status: 400 });
      }
      if (!productLineName) {
        return data({ error: "Missing product line name" }, { status: 400 });
      }

      // First try to find the set in the database
      const categorySet = await categorySetsDb.findOne({ name: setName });
      let setProducts: SetProduct[] = [];

      if (categorySet) {
        // Set exists in database, get existing set products
        setProducts = await setProductsDb.find({
          setNameId: categorySet.setNameId,
        });

        if (!setProducts.length) {
          // Try to fetch using the set cards endpoint if we have the setNameId
          try {
            const setCardsResponse = await getSetCards({
              setId: categorySet.setNameId,
            });
            const seen = new Set<number>();
            setProducts = [];

            for (const card of setCardsResponse.result) {
              if (seen.has(card.productID)) continue;
              seen.add(card.productID);
              setProducts.push({
                setNameId: categorySet.setNameId,
                productId: card.productID,
                game: card.game,
                number: card.number,
                productName: card.productName,
                rarity: card.rarity,
                set: card.set,
                setAbbrv: card.setAbbrv,
                type: card.type,
              });
            }

            // Store set products in database
            await Promise.all(
              setProducts.map((prod) =>
                setProductsDb.update({ productId: prod.productId }, prod, {
                  upsert: true,
                })
              )
            );
          } catch (err) {
            // Fall back to search if set cards API fails
            console.warn(
              `Set cards API failed for set ${setName}, falling back to search`
            );
          }
        }
      }

      // If we don't have set products yet (either set not in DB or set cards API failed),
      // use the search API to find products by set name
      if (!setProducts.length) {
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
            return data(
              {
                error: `No products found for set "${setName}" in product line "${productLineName}". Please check the set name and product line.`,
              },
              { status: 404 }
            );
          }

          const seen = new Set<number>();
          for (const card of searchResults) {
            if (seen.has(card.productId)) continue;
            seen.add(card.productId);
            setProducts.push({
              setNameId: categorySet?.setNameId || 0, // Use 0 if not in database yet
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

          // Store set products in database for future use
          await Promise.all(
            setProducts.map((prod) =>
              setProductsDb.update({ productId: prod.productId }, prod, {
                upsert: true,
              })
            )
          );
        } catch (err) {
          return data(
            { error: `Failed to search for products: ${String(err)}` },
            { status: 500 }
          );
        }
      }

      // Fetch and upsert product details and SKUs
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        setProducts
      );

      return data(
        {
          message: `Fetched and verified products and SKUs for set "${setName}" in product line "${productLineName}". Set products: ${setProducts.length}, products: ${productCount}, SKUs: ${totalSkus}.`,
        },
        { status: 200 }
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  }

  return data({ error: "Unknown action" }, { status: 400 });
}

export async function loader() {
  // Load all product lines from NeDB
  const productLines = await productLinesDb.find({});
  return { productLines };
}

// --- Refactored helpers for category, set, and product level processing ---

/**
 * Fetches and upserts all sets for a given categoryId. Always calls the API to verify all sets are in the database.
 */
async function fetchAndUpsertCategorySets(categoryId: number) {
  // Find the selected product line to get the url name
  const selectedProductLine = await productLinesDb.findOne({
    productLineId: categoryId,
  });
  if (!selectedProductLine) {
    throw new Error(`No product line found for categoryId ${categoryId}`);
  }

  // Always fetch from API to ensure we have the latest sets
  const fetchedSetsResp = await getCatalogSetNames({ categoryId });
  const fetchedSets = fetchedSetsResp.results;
  if (!fetchedSets || !fetchedSets.length) {
    throw new Error(
      `No sets found from getCatalogSetNames for categoryId ${categoryId}`
    );
  }

  // Get existing sets from database
  const existingSets = await categorySetsDb.find({ categoryId });
  const existingSetIds = new Set(existingSets.map((set) => set.setNameId));

  // Identify missing sets that need to be inserted
  const missingSets = fetchedSets.filter(
    (set) => !existingSetIds.has(set.setNameId)
  );

  // Upsert all fetched sets (will update existing and insert missing)
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

  return {
    sets: fetchedSets,
    productLine: selectedProductLine.productLineUrlName,
  };
}

/**
 * Fetches and upserts all set products for a list of sets and a product line name. Returns all set products.
 */
async function fetchAndUpsertSetProducts(
  sets: CategorySet[],
  productLine: string
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
              productLineName: [productLine],
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
            game: productLine,
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
async function fetchAndUpsertProductsAndSkus(allSetProducts: SetProduct[]) {
  let productCount = 0;
  let totalSkus = 0;
  const PRODUCT_CONCURRENCY = 100;
  let prodIdx = 0;
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
          await productsDb.update({ productId: details.productId }, details, {
            upsert: true,
          });
        } catch (err) {
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
      const existingSkus = await skusDb.find<Sku>({ sku: { $in: skuIds } });
      const existingSkuSet = new Set(existingSkus.map((s) => s.sku));
      const skusToInsert = skusToUpsert.filter(
        (sku) => !existingSkuSet.has(sku.sku)
      );
      if (skusToInsert.length > 0) {
        try {
          await skusDb.insert(skusToInsert);
        } catch (err) {}
      }
    }
  )) {
    // No-op
  }
  return { productCount, totalSkus };
}

export default function Home() {
  const allCategory3DataFetcher = useFetcher<typeof action>();
  const allProductLinesFetcher = useFetcher();
  const setProductsFetcher = useFetcher<typeof action>();
  const { productLines } = useLoaderData() as {
    productLines: ProductLine[];
  };
  const [selectedProductLineId, setSelectedProductLineId] = useState<
    number | null
  >(productLines.length > 0 ? productLines[0].productLineId : null);
  const [selectedSetName, setSelectedSetName] = useState<string>("");
  const [selectedProductLineName, setSelectedProductLineName] =
    useState<string>("");

  return (
    <Box sx={{ p: 3 }}>
      {/* Navigation Links */}
      <Paper sx={{ p: 2, mb: 3 }} elevation={2}>
        <Typography variant="h5" gutterBottom>
          TCGPlayer Automation Tools
        </Typography>
        <Stack direction="row" spacing={2}>
          <Button
            component={Link}
            to="/pricer"
            variant="contained"
            color="primary"
          >
            CSV Pricer
          </Button>
          <Button
            component={Link}
            to="/seller-pricer"
            variant="contained"
            color="secondary"
          >
            Seller Inventory Pricer
          </Button>
          <Button
            component={Link}
            to="/inventory-manager"
            variant="contained"
            color="success"
          >
            Inventory Manager
          </Button>
          <Button
            component={Link}
            to="/pending-inventory-pricer"
            variant="contained"
            color="info"
          >
            Pending Inventory Pricer
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Use the CSV Pricer to upload and price TCGPlayer CSV files, the Seller
          Inventory Pricer to fetch and price all listings for a specific
          seller, the Inventory Manager to add new inventory items, or the
          Pending Inventory Pricer to process all pending inventory and generate
          pricing.
        </Typography>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h4" gutterBottom>
          Fetch & Verify All Category Data
        </Typography>
        <allCategory3DataFetcher.Form method="post">
          <input
            type="hidden"
            name="actionType"
            value="fetchAllCategory3Data"
          />
          <FormControl sx={{ minWidth: 220, marginRight: 2 }}>
            <InputLabel id="product-line-select-label">Product Line</InputLabel>
            <Select
              labelId="product-line-select-label"
              id="product-line-select"
              name="categoryId"
              value={selectedProductLineId ?? ""}
              label="Product Line"
              onChange={(e) => setSelectedProductLineId(Number(e.target.value))}
            >
              {productLines.map((pl: ProductLine) => (
                <MenuItem key={pl.productLineId} value={pl.productLineId}>
                  {pl.productLineName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={selectedProductLineId === null}
          >
            Fetch & Verify All Category Data
          </Button>
        </allCategory3DataFetcher.Form>
      </Paper>
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h4" gutterBottom>
          Fetch All Product Lines
        </Typography>
        <allProductLinesFetcher.Form method="post">
          <input type="hidden" name="actionType" value="fetchAllProductLines" />
          <Button type="submit" variant="contained" color="secondary">
            Fetch All Product Lines
          </Button>
        </allProductLinesFetcher.Form>
      </Paper>
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h4" gutterBottom>
          Update Product and SKUs by Product ID
        </Typography>
        <allCategory3DataFetcher.Form method="post">
          <input type="hidden" name="actionType" value="updateProductAndSkus" />
          <FormControl sx={{ minWidth: 220, marginRight: 2 }}>
            <InputLabel id="product-id-input-label">Product ID</InputLabel>
            <input
              id="product-id-input"
              name="productId"
              type="number"
              min="1"
              required
              style={{ padding: 8, fontSize: 16, width: 200 }}
              placeholder="Enter Product ID"
            />
          </FormControl>
          <Button type="submit" variant="contained" color="info">
            Update Product & SKUs
          </Button>
        </allCategory3DataFetcher.Form>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h4" gutterBottom>
          Fetch Products and SKUs by Set
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Enter a set name and product line to fetch all products and SKUs. This
          works even for sets not yet in the database.
        </Typography>
        <setProductsFetcher.Form method="post">
          <input
            type="hidden"
            name="actionType"
            value="fetchSetProductsAndSkus"
          />
          <Box
            sx={{
              display: "flex",
              gap: 2,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <TextField
              label="Set Name"
              name="setName"
              value={selectedSetName}
              onChange={(e) => setSelectedSetName(e.target.value)}
              required
              placeholder="e.g., Duskmourn: House of Horror"
              sx={{ minWidth: 300 }}
            />
            <FormControl sx={{ minWidth: 220 }}>
              <InputLabel id="product-line-select-label-2">
                Product Line
              </InputLabel>
              <Select
                labelId="product-line-select-label-2"
                id="product-line-select-2"
                name="productLineName"
                value={selectedProductLineName}
                label="Product Line"
                onChange={(e) => setSelectedProductLineName(e.target.value)}
                required
              >
                {productLines.map((pl: ProductLine) => (
                  <MenuItem
                    key={pl.productLineId}
                    value={pl.productLineUrlName}
                  >
                    {pl.productLineName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              type="submit"
              variant="contained"
              color="success"
              disabled={!selectedSetName || !selectedProductLineName}
            >
              Fetch Set Products & SKUs
            </Button>
          </Box>
        </setProductsFetcher.Form>
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
      {allProductLinesFetcher.data &&
      "message" in allProductLinesFetcher.data ? (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="h6">Product Lines Fetch Result</Typography>
          <pre>{allProductLinesFetcher.data.message}</pre>
        </Paper>
      ) : allProductLinesFetcher.data &&
        "error" in allProductLinesFetcher.data ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography variant="h6">Error</Typography>
          <pre style={{ margin: 0 }}>{allProductLinesFetcher.data.error}</pre>
        </Alert>
      ) : null}

      {setProductsFetcher.data && "message" in setProductsFetcher.data ? (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="h6">Set Products & SKUs Fetch Result</Typography>
          <pre>{setProductsFetcher.data.message}</pre>
        </Paper>
      ) : setProductsFetcher.data && "error" in setProductsFetcher.data ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography variant="h6">Error</Typography>
          <pre style={{ margin: 0 }}>{setProductsFetcher.data.error}</pre>
        </Alert>
      ) : null}
    </Box>
  );
}
