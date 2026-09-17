import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  data,
  Link,
  useFetcher,
  type LoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
} from "react-router";
import {
  categorySetsRepository,
  productLinesRepository,
  productsRepository,
  setProductsRepository,
  skusRepository,
} from "../core/db";
import { getHttpConfig } from "../core/config/httpConfig.server";
import { getAllProducts } from "../integrations/tcgplayer/client/get-search-results.server";
import type { SetProduct } from "../shared/data-types/setProduct";
import {
  fetchAllProductLines,
  fetchAndUpsertCategorySets,
  fetchAndUpsertProductsAndSkus,
  fetchAndUpsertSetProducts,
} from "./home.server";

type ActionResponse = {
  message?: string;
  error?: string;
};

export const meta: MetaFunction = () => {
  return [
    { title: "Data Management" },
    {
      name: "description",
      content: "Fetch and manage product lines, categories, and SKU data",
    },
  ];
};

export async function action({ request }: LoaderFunctionArgs) {
  const formData = await request.formData();

  const actionType = formData.get("actionType");

  if (actionType === "fetchAllCategory3Data") {
    try {
      const categoryId = Number(formData.get("categoryId"));
      const { sets, productLine } = await fetchAndUpsertCategorySets(categoryId);
      const allSetProducts = await fetchAndUpsertSetProducts(sets, productLine);
      const { productCount, totalSkus } = await fetchAndUpsertProductsAndSkus(
        allSetProducts,
        productLine.productLineId,
      );

      return data(
        {
          message: `Fetched and verified all sets, products, and skus for category ${categoryId} using PostgreSQL. Sets: ${sets.length}, set-products: ${allSetProducts.length}, products: ${productCount}, skus: ${totalSkus}.`,
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

      const existingProduct = await productsRepository.findByProductId(
        productId,
        productLineId,
      );

      if (!existingProduct) {
        return data(
          {
            error: `Product with ID ${productId} not found in product line ${productLineId}`,
          },
          { status: 404 },
        );
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

      if (deleteExisting) {
        const productLineForDelete = await productLinesRepository.findByUrlName(
          productLineName,
        );

        if (!productLineForDelete) {
          return data(
            { error: `Product line not found: ${productLineName}` },
            { status: 400 },
          );
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
        return data(
          { error: `Product line not found: ${productLineName}` },
          { status: 400 },
        );
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
          return data(
            {
              error: `No products found for set "${setName}" in product line "${productLineName}". Please check the set name and product line.`,
            },
            { status: 404 },
          );
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
        return data(
          { error: `Failed to search for products: ${String(error)}` },
          { status: 500 },
        );
      }

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
  const productLines = await productLinesRepository.findAll();
  const httpConfig = await getHttpConfig();

  return {
    productLines,
    hasAuthCookie: !!httpConfig.tcgAuthCookie,
  };
}

export default function Home() {
  const refreshProductLinesFetcher = useFetcher<typeof action>();
  const syncProductLineFetcher = useFetcher<typeof action>();
  const repairProductFetcher = useFetcher<typeof action>();
  const hydrateSetFetcher = useFetcher<typeof action>();
  const { productLines, hasAuthCookie } = useLoaderData<typeof loader>();

  const [selectedProductLineId, setSelectedProductLineId] = useState<
    number | ""
  >("");
  const [updateProductLineId, setUpdateProductLineId] = useState<number | "">(
    "",
  );
  const [selectedSetName, setSelectedSetName] = useState("");
  const [selectedProductLineName, setSelectedProductLineName] = useState("");
  const [deleteExistingSet, setDeleteExistingSet] = useState(false);
  const [productId, setProductId] = useState("");

  useEffect(() => {
    const firstProductLine = productLines[0];

    if (!firstProductLine) {
      return;
    }

    setSelectedProductLineId((currentValue) => {
      const stillValid = productLines.some(
        (productLine) => productLine.productLineId === currentValue,
      );
      return stillValid ? currentValue : firstProductLine.productLineId;
    });

    setUpdateProductLineId((currentValue) => {
      const stillValid = productLines.some(
        (productLine) => productLine.productLineId === currentValue,
      );
      return stillValid ? currentValue : firstProductLine.productLineId;
    });

    setSelectedProductLineName((currentValue) => {
      const stillValid = productLines.some(
        (productLine) => productLine.productLineUrlName === currentValue,
      );
      return stillValid ? currentValue : firstProductLine.productLineUrlName;
    });
  }, [productLines]);

  const selectedProductLine = productLines.find(
    (productLine) => productLine.productLineId === selectedProductLineId,
  );
  const repairTargetLine = productLines.find(
    (productLine) => productLine.productLineId === updateProductLineId,
  );
  const selectedSetProductLine = productLines.find(
    (productLine) => productLine.productLineUrlName === selectedProductLineName,
  );

  return (
    <Box sx={{ maxWidth: 1200, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Data Management
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Refresh the local TCGPlayer catalog: product lines, sets, products, and
        SKUs. Use the smallest job that fixes the problem.
      </Typography>

      {!hasAuthCookie && (
        <Alert
          severity="warning"
          sx={{ mb: 3 }}
          action={
            <Button
              component={Link}
              to="/http-configuration"
              color="inherit"
              size="small"
              variant="outlined"
            >
              Fix Auth
            </Button>
          }
        >
          Live TCGPlayer requests are blocked until the HTTP configuration page
          has a valid authentication cookie.
        </Alert>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "repeat(2, minmax(0, 1fr))" },
          gap: 3,
        }}
      >
        <MaintenanceActionCard
          title="Refresh product lines"
          description="Pull the current list of TCGPlayer product lines and category filters before deeper maintenance."
        >
          <refreshProductLinesFetcher.Form method="post">
            <input type="hidden" name="actionType" value="fetchAllProductLines" />
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Run this when you notice new product lines, missing category
                filters, or a stale list in the database.
              </Typography>
              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={refreshProductLinesFetcher.state !== "idle"}
              >
                {refreshProductLinesFetcher.state === "idle"
                  ? "Refresh Product Lines"
                  : "Refreshing Product Lines..."}
              </Button>
            </Stack>
          </refreshProductLinesFetcher.Form>
          <ActionFeedback
            fetcher={refreshProductLinesFetcher}
            idleMessage="No refresh has been run in this session yet."
          />
        </MaintenanceActionCard>

        <MaintenanceActionCard
          title="Sync one product line"
          description="Rebuild sets, set products, products, and SKUs for a selected category when you need full coverage."
        >
          <syncProductLineFetcher.Form method="post">
            <input type="hidden" name="actionType" value="fetchAllCategory3Data" />
            <Stack spacing={2}>
              <FormControl fullWidth>
                <InputLabel id="sync-product-line-label">Product line</InputLabel>
                <Select
                  labelId="sync-product-line-label"
                  name="categoryId"
                  value={selectedProductLineId}
                  label="Product line"
                  onChange={(event) =>
                    setSelectedProductLineId(Number(event.target.value))
                  }
                >
                  {productLines.map((productLine) => (
                    <MenuItem
                      key={productLine.productLineId}
                      value={productLine.productLineId}
                    >
                      {productLine.productLineName}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Typography variant="body2" color="text.secondary">
                Target:{" "}
                <strong>
                  {selectedProductLine?.productLineName ?? "Choose a product line"}
                </strong>
              </Typography>

              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={
                  !selectedProductLineId || syncProductLineFetcher.state !== "idle"
                }
              >
                {syncProductLineFetcher.state === "idle"
                  ? "Sync Product Line"
                  : "Syncing Product Line..."}
              </Button>
            </Stack>
          </syncProductLineFetcher.Form>
          <ActionFeedback
            fetcher={syncProductLineFetcher}
            idleMessage="Use this for the heavy-duty refresh when a whole category needs reconciliation."
          />
        </MaintenanceActionCard>

        <MaintenanceActionCard
          title="Repair one product"
          description="Refetch a single product and its SKUs when one listing is wrong, missing, or tied to the wrong set."
        >
          <repairProductFetcher.Form method="post">
            <input type="hidden" name="actionType" value="updateProductAndSkus" />
            <input
              type="hidden"
              name="productLineId"
              value={updateProductLineId === "" ? "" : String(updateProductLineId)}
            />
            <Stack spacing={2}>
              <FormControl fullWidth>
                <InputLabel id="repair-product-line-label">Product line</InputLabel>
                <Select
                  labelId="repair-product-line-label"
                  value={updateProductLineId}
                  label="Product line"
                  onChange={(event) =>
                    setUpdateProductLineId(Number(event.target.value))
                  }
                >
                  {productLines.map((productLine) => (
                    <MenuItem
                      key={productLine.productLineId}
                      value={productLine.productLineId}
                    >
                      {productLine.productLineName}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label="Product ID"
                name="productId"
                type="number"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                inputProps={{ min: 1 }}
                placeholder="Enter the exact TCGPlayer product ID"
                fullWidth
                required
              />

              <Typography variant="body2" color="text.secondary">
                Repair scope:{" "}
                <strong>
                  {repairTargetLine?.productLineName ?? "Choose a product line"}
                </strong>
              </Typography>

              <Button
                type="submit"
                variant="contained"
                size="large"
                color="secondary"
                disabled={
                  !updateProductLineId ||
                  !productId.trim() ||
                  repairProductFetcher.state !== "idle"
                }
              >
                {repairProductFetcher.state === "idle"
                  ? "Repair Product and SKUs"
                  : "Repairing Product..."}
              </Button>
            </Stack>
          </repairProductFetcher.Form>
          <ActionFeedback
            fetcher={repairProductFetcher}
            idleMessage="Best for isolated catalog drift without paying the cost of a broader sync."
          />
        </MaintenanceActionCard>

        <MaintenanceActionCard
          title="Hydrate one set"
          description="Fetch set products and SKUs directly from TCGPlayer, even if the set is not fully represented locally yet."
        >
          <hydrateSetFetcher.Form method="post">
            <input type="hidden" name="actionType" value="fetchSetProductsAndSkus" />
            <Stack spacing={2}>
              <TextField
                label="Set name"
                name="setName"
                value={selectedSetName}
                onChange={(event) => setSelectedSetName(event.target.value)}
                placeholder="Example: Duskmourn: House of Horror"
                fullWidth
                required
              />

              <FormControl fullWidth>
                <InputLabel id="hydrate-set-product-line-label">
                  Product line
                </InputLabel>
                <Select
                  labelId="hydrate-set-product-line-label"
                  name="productLineName"
                  value={selectedProductLineName}
                  label="Product line"
                  onChange={(event) =>
                    setSelectedProductLineName(String(event.target.value))
                  }
                >
                  {productLines.map((productLine) => (
                    <MenuItem
                      key={productLine.productLineId}
                      value={productLine.productLineUrlName}
                    >
                      {productLine.productLineName}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControlLabel
                control={
                  <Checkbox
                    name="deleteExistingSet"
                    checked={deleteExistingSet}
                    onChange={(event) => setDeleteExistingSet(event.target.checked)}
                  />
                }
                label="Delete existing set data first and fully refetch it"
              />

              <Typography variant="body2" color="text.secondary">
                Destination:{" "}
                <strong>
                  {selectedSetProductLine?.productLineName ??
                    "Choose the target product line"}
                </strong>
              </Typography>

              <Button
                type="submit"
                variant="contained"
                size="large"
                color="success"
                disabled={
                  !selectedSetName.trim() ||
                  !selectedProductLineName ||
                  hydrateSetFetcher.state !== "idle"
                }
              >
                {hydrateSetFetcher.state === "idle"
                  ? "Hydrate Set Products and SKUs"
                  : "Hydrating Set..."}
              </Button>
            </Stack>
          </hydrateSetFetcher.Form>
          <ActionFeedback
            fetcher={hydrateSetFetcher}
            idleMessage="Use the full refetch checkbox when an existing set needs to be cleared and rebuilt cleanly."
          />
        </MaintenanceActionCard>
      </Box>
    </Box>
  );
}

function MaintenanceActionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Paper elevation={2} sx={{ p: 3, height: "100%" }}>
      <Stack spacing={2}>
        <Typography variant="h6">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>

        <Box>{children}</Box>
      </Stack>
    </Paper>
  );
}

function ActionFeedback({
  fetcher,
  idleMessage,
}: {
  fetcher: { state: string; data?: ActionResponse };
  idleMessage: string;
}) {
  if (fetcher.state !== "idle") {
    return (
      <Alert severity="info" sx={{ mt: 2 }}>
        Request in progress. This panel will keep the result attached to this job.
      </Alert>
    );
  }

  if (fetcher.data?.error) {
    return (
      <Alert severity="error" sx={{ mt: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Job failed
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
          {fetcher.data.error}
        </Typography>
      </Alert>
    );
  }

  if (fetcher.data?.message) {
    return (
      <Alert severity="success" sx={{ mt: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Job complete
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
          {fetcher.data.message}
        </Typography>
      </Alert>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{ mt: 2, p: 2, bgcolor: "background.default" }}
    >
      <Typography variant="body2" color="text.secondary">
        {idleMessage}
      </Typography>
    </Paper>
  );
}
