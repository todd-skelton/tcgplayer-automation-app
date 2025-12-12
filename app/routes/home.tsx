import type { Route } from "./+types/home";
import {
  data,
  useFetcher,
  type LoaderFunctionArgs,
  useLoaderData,
  Link,
} from "react-router";
import { getAllProducts } from "../integrations/tcgplayer/client/get-search-results";
import { type SetProduct } from "../shared/data-types/setProduct";
import { type CategorySet } from "../shared/data-types/categorySet";
import { getProductDetails } from "../integrations/tcgplayer/client/get-product-details";
import { getCatalogSetNames } from "../integrations/tcgplayer/client/get-catalog-set-names";
import type { Product } from "../features/inventory-management/types/product";
import type { Sku } from "../shared/data-types/sku";
import { processWithConcurrency } from "../core/processWithConcurrency";
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
  Checkbox,
  FormControlLabel,
} from "@mui/material";
import { getProductLines } from "../integrations/tcgplayer/client/get-product-lines";
import { getCategoryFilters } from "../integrations/tcgplayer/client/get-category-filters";
import type { ProductLine } from "../shared/data-types/productLine";
import { useEffect, useState } from "react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export async function action({ request }: LoaderFunctionArgs) {
  // Dynamic import of datastores for server-side only
  const {
    categorySetsDb,
    getProductsDbShard,
    setProductsDb,
    getSkusDbShard,
    productLinesDb,
    categoryFiltersDb,
    productsDb,
    skusDb,
  } = await import("../datastores");

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
        allSetProducts,
        productLine.productLineId
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
      const productLineId = formData.get("productLineId")
        ? Number(formData.get("productLineId"))
        : null;

      if (!productId) {
        return data({ error: "Missing or invalid productId" }, { status: 400 });
      }

      if (!productLineId) {
        return data(
          { error: "Product Line ID is required for optimized performance" },
          { status: 400 }
        );
      }

      // ✅ Efficient: Use shard-targeted query with required productLineId
      const existingProduct = await getProductsDbShard(productLineId).findOne({
        productId,
        productLineId,
      });

      if (!existingProduct) {
        return data(
          {
            error: `Product with ID ${productId} not found in product line ${productLineId}`,
          },
          { status: 404 }
        );
      }

      // Use the same logic as fetchAndUpsertProductsAndSkus but for a single product
      const dummySetProduct = { productId } as SetProduct;
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        [dummySetProduct],
        existingProduct.productLineId
      );
      return data(
        {
          message: `Updated product and skus for productId ${productId}. Products: ${productCount}, skus: ${totalSkus}. (Optimized with product line targeting)`,
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
      const deleteExisting = formData.get("deleteExistingSet") === "on";
      if (!setName) {
        return data({ error: "Missing set name" }, { status: 400 });
      }
      if (!productLineName) {
        return data({ error: "Missing product line name" }, { status: 400 });
      }

      console.log(deleteExisting, formData.get("deleteExistingSet"));

      // If delete option is selected, remove existing data first
      if (deleteExisting) {
        // First find the product line to get the categoryId
        const productLineForDelete = await productLinesDb.findOne({
          productLineUrlName: productLineName,
        });

        if (!productLineForDelete) {
          return data(
            { error: `Product line not found: ${productLineName}` },
            { status: 400 }
          );
        }

        // Find the set in the database using categoryId and set name
        const categorySet = await categorySetsDb.findOne({
          categoryId: productLineForDelete.productLineId,
          urlName: setName,
        });

        if (categorySet) {
          // Get the sharded datastores for this product line
          const productsDbShard = getProductsDbShard(
            productLineForDelete.productLineId
          );
          const skusDbShard = getSkusDbShard(
            productLineForDelete.productLineId
          );

          // Delete set products, products, and SKUs associated with this set
          await setProductsDb.remove(
            { setNameId: categorySet.setNameId },
            { multi: true }
          );
          await productsDbShard.remove(
            {
              setId: categorySet.setNameId,
              productLineId: productLineForDelete.productLineId,
            },
            { multi: true }
          );
          await skusDbShard.remove(
            {
              setId: categorySet.setNameId,
              productLineId: productLineForDelete.productLineId,
            },
            { multi: true }
          );
        }
      }

      // Find the product line to get the categoryId for proper set lookup
      const productLine = await productLinesDb.findOne({
        productLineUrlName: productLineName,
      });

      if (!productLine) {
        return data(
          { error: `Product line not found: ${productLineName}` },
          { status: 400 }
        );
      }

      // First try to find the set in the database using categoryId and urlName only
      let categorySet = await categorySetsDb.findOne({
        categoryId: productLine.productLineId,
        urlName: setName,
      });

      // If not found in database, try to fetch and store the set data first
      if (!categorySet) {
        try {
          const { sets } = await fetchAndUpsertCategorySets(
            productLine.productLineId
          );
          // Try to find the set again after fetching
          categorySet = await categorySetsDb.findOne({
            categoryId: productLine.productLineId,
            urlName: setName,
          });
        } catch (err) {
          console.warn(
            `Could not fetch sets for category ${productLine.productLineId}:`,
            err
          );
        }
      }

      let setProducts: SetProduct[] = [];

      // Always fetch from API to ensure we have the latest products and any changes
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
            setNameId: categorySet?.setNameId || 0, // This should now have the correct value
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

        // Log warning if setNameId is still 0
        if (setProducts.length > 0 && setProducts[0].setNameId === 0) {
          console.warn(
            `Warning: setNameId is 0 for set "${setName}" in product line "${productLineName}". CategorySet found:`,
            categorySet
          );
        }

        // Always update/store set products in database to capture any changes
        await Promise.all(
          setProducts.map((prod) =>
            setProductsDb.update({ productId: prod.productId }, prod, {
              upsert: true,
            })
          )
        );
      } catch (err) {
        console.error(`[API] Failed to search for products:`, err);
        return data(
          { error: `Failed to search for products: ${String(err)}` },
          { status: 500 }
        );
      }

      // Fetch and upsert product details and SKUs
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        setProducts,
        productLine.productLineId
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
  // Dynamic import of datastores for server-side only
  const { productLinesDb } = await import("../datastores");
  const { getHttpConfig } = await import("../core/config/httpConfig");

  // Load all product lines from NeDB
  const productLines = await productLinesDb.find({});
  const httpConfig = await getHttpConfig();

  return {
    productLines,
    hasAuthCookie: !!httpConfig.tcgAuthCookie,
  };
}

// --- Refactored helpers for category, set, and product level processing ---

/**
 * Fetches and upserts all sets for a given categoryId. Always calls the API to verify all sets are in the database.
 */
async function fetchAndUpsertCategorySets(categoryId: number) {
  // Dynamic import of datastores for server-side only
  const { productLinesDb, categorySetsDb } = await import("../datastores");

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
async function fetchAndUpsertSetProducts(
  sets: CategorySet[],
  productLine: ProductLine
) {
  // Dynamic import of datastores for server-side only
  const { setProductsDb } = await import("../datastores");

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
async function fetchAndUpsertProductsAndSkus(
  allSetProducts: SetProduct[],
  productLineId: number
) {
  // Dynamic import of datastores for server-side only
  const { getProductsDbShard, getSkusDbShard } = await import("../datastores");

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

export default function Home() {
  const allCategory3DataFetcher = useFetcher<typeof action>();
  const allProductLinesFetcher = useFetcher();
  const setProductsFetcher = useFetcher<typeof action>();
  const { productLines, hasAuthCookie } = useLoaderData() as {
    productLines: ProductLine[];
    hasAuthCookie: boolean;
  };
  const [selectedProductLineId, setSelectedProductLineId] = useState<
    number | null
  >(productLines.length > 0 ? productLines[0].productLineId : null);
  const [selectedSetName, setSelectedSetName] = useState<string>("");
  const [selectedProductLineName, setSelectedProductLineName] =
    useState<string>("");
  const [deleteExistingSet, setDeleteExistingSet] = useState<boolean>(false);

  // State for the Update Product form
  const [updateProductLineId, setUpdateProductLineId] = useState<number | null>(
    productLines.length > 0 ? productLines[0].productLineId : null
  );

  return (
    <Box sx={{ p: 3 }}>
      {!hasAuthCookie && (
        <Alert severity="error" sx={{ mb: 3 }}>
          <Typography variant="body1" gutterBottom>
            <strong>Authentication Required!</strong> You need to configure your
            TCGPlayer authentication cookie before using any API features.
          </Typography>
          <Button
            component={Link}
            to="/http-configuration"
            variant="contained"
            size="small"
            sx={{ mt: 1 }}
          >
            Configure Now
          </Button>
        </Alert>
      )}

      {/* Navigation Links */}
      <Paper sx={{ p: 2, mb: 3 }} elevation={2}>
        <Typography variant="h5" gutterBottom>
          TCGPlayer Automation Tools
        </Typography>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
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
        <Stack direction="row" spacing={2}>
          <Button
            component={Link}
            to="/configuration"
            variant="outlined"
            color="primary"
          >
            ⚙️ Configuration
          </Button>
          <Button
            component={Link}
            to="/http-configuration"
            variant="outlined"
            color="primary"
          >
            🔐 HTTP Configuration
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
          <input
            type="hidden"
            name="productLineId"
            value={updateProductLineId?.toString() || ""}
          />
          <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
            <FormControl sx={{ minWidth: 200 }} required>
              <InputLabel id="update-product-line-label">
                Product Line *
              </InputLabel>
              <Select
                labelId="update-product-line-label"
                value={updateProductLineId || ""}
                label="Product Line *"
                onChange={(e) =>
                  setUpdateProductLineId(
                    e.target.value ? Number(e.target.value) : null
                  )
                }
                required
              >
                {productLines.map((line) => (
                  <MenuItem key={line.productLineId} value={line.productLineId}>
                    {line.productLineName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl sx={{ minWidth: 220 }}>
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
            <Button
              type="submit"
              variant="contained"
              color="info"
              disabled={!updateProductLineId}
            >
              Update Product & SKUs
            </Button>
          </Box>
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
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Checkbox
                  name="deleteExistingSet"
                  checked={deleteExistingSet}
                  onChange={(e) => setDeleteExistingSet(e.target.checked)}
                />
              }
              label="Delete existing set data and refetch (force refresh)"
            />
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
