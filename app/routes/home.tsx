import {
  data,
  useFetcher,
  type LoaderFunctionArgs,
  useLoaderData,
  Link,
  type MetaFunction,
} from "react-router";
import type { ProductLine } from "../shared/data-types/productLine";
import type { SetProduct } from "../shared/data-types/setProduct";
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
import { useEffect, useState } from "react";
import { getHttpConfig } from "../core/config/httpConfig.server";
import {
  productLinesDb,
  categorySetsDb,
  setProductsDb,
  getProductsDbShard,
  getSkusDbShard,
} from "../datastores.server";
import {
  fetchAndUpsertCategorySets,
  fetchAndUpsertSetProducts,
  fetchAndUpsertProductsAndSkus,
  fetchAllProductLines,
} from "./home.server";
import { getAllProducts } from "../integrations/tcgplayer/client/get-search-results.server";

export const meta: MetaFunction = () => {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
};

export async function action({ request }: LoaderFunctionArgs) {
  const formData = await request.formData();

  const actionType = formData.get("actionType");

  if (actionType === "fetchAllCategory3Data") {
    try {
      const categoryId = Number(formData.get("categoryId"));
      // 1. CATEGORY SETS
      const { sets, productLine } = await fetchAndUpsertCategorySets(
        categoryId,
      );
      // 2. SET PRODUCTS
      const allSetProducts = await fetchAndUpsertSetProducts(sets, productLine);

      // 3. PRODUCTS
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        allSetProducts,
        productLine.productLineId,
      );

      return data(
        {
          message: `Fetched and verified all sets, products, and skus for category 3 using NeDB. Sets: ${sets.length}, set-products: ${allSetProducts.length}, products: ${productCount}, skus: ${totalSkus}.`,
        },
        { status: 200 },
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  }

  if (actionType === "fetchAllProductLines") {
    try {
      const productLines = await fetchAllProductLines();
      return data(
        {
          message: `Fetched and upserted ${productLines.length} product lines and their category filters.`,
        },
        { status: 200 },
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
          { status: 400 },
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
          { status: 404 },
        );
      }

      // Use the same logic as fetchAndUpsertProductsAndSkus but for a single product
      // Force refresh to detect and fix set reclassifications
      const dummySetProduct = { productId } as SetProduct;
      const result = await fetchAndUpsertProductsAndSkus(
        [dummySetProduct],
        existingProduct.productLineId,
        true, // forceRefresh: always fetch fresh data to detect set changes
      );

      // Build response message including set correction details if applicable
      let message = `Updated product and skus for productId ${productId}. Products: ${result.productCount}, skus: ${result.totalSkus}.`;
      if (result.setChanges > 0) {
        message += ` Set reclassification detected and corrected: ${result.skusUpdated} SKUs updated, ${result.setProductsUpdated} SetProducts updated, ${result.pendingInventoryUpdated} PendingInventory entries updated.`;
      }

      return data({ message }, { status: 200 });
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
            { status: 400 },
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
            productLineForDelete.productLineId,
          );
          const skusDbShard = getSkusDbShard(
            productLineForDelete.productLineId,
          );

          // Delete set products, products, and SKUs associated with this set
          await setProductsDb.remove(
            { setNameId: categorySet.setNameId },
            { multi: true },
          );
          await productsDbShard.remove(
            {
              setId: categorySet.setNameId,
              productLineId: productLineForDelete.productLineId,
            },
            { multi: true },
          );
          await skusDbShard.remove(
            {
              setId: categorySet.setNameId,
              productLineId: productLineForDelete.productLineId,
            },
            { multi: true },
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
          { status: 400 },
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
            productLine.productLineId,
          );
          // Try to find the set again after fetching
          categorySet = await categorySetsDb.findOne({
            categoryId: productLine.productLineId,
            urlName: setName,
          });
        } catch (err) {
          console.warn(
            `Could not fetch sets for category ${productLine.productLineId}:`,
            err,
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
            { status: 404 },
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
            categorySet,
          );
        }

        // Always update/store set products in database to capture any changes
        await Promise.all(
          setProducts.map((prod) =>
            setProductsDb.update({ productId: prod.productId }, prod, {
              upsert: true,
            }),
          ),
        );
      } catch (err) {
        console.error(`[API] Failed to search for products:`, err);
        return data(
          { error: `Failed to search for products: ${String(err)}` },
          { status: 500 },
        );
      }

      // Fetch and upsert product details and SKUs
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        setProducts,
        productLine.productLineId,
      );

      return data(
        {
          message: `Fetched and verified products and SKUs for set "${setName}" in product line "${productLineName}". Set products: ${setProducts.length}, products: ${productCount}, SKUs: ${totalSkus}.`,
        },
        { status: 200 },
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
  const httpConfig = await getHttpConfig();

  return {
    productLines,
    hasAuthCookie: !!httpConfig.tcgAuthCookie,
  };
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
    productLines.length > 0 ? productLines[0].productLineId : null,
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
                    e.target.value ? Number(e.target.value) : null,
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
