import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { SvgIconComponent } from "@mui/icons-material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HttpIcon from "@mui/icons-material/Http";
import Inventory2Icon from "@mui/icons-material/Inventory2";
import ManageSearchIcon from "@mui/icons-material/ManageSearch";
import SettingsIcon from "@mui/icons-material/Settings";
import StorageIcon from "@mui/icons-material/Storage";
import StorefrontIcon from "@mui/icons-material/Storefront";
import SyncAltIcon from "@mui/icons-material/SyncAlt";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
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
import { alpha } from "@mui/material/styles";
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

type ShortcutLink = {
  title: string;
  description: string;
  to: string;
  icon: SvgIconComponent;
};

const workflowShortcuts: ShortcutLink[] = [
  {
    title: "CSV Pricer",
    description: "Upload marketplace CSV exports and move into pricing fast.",
    to: "/pricer",
    icon: UploadFileIcon,
  },
  {
    title: "Seller Pricer",
    description: "Freeze live seller inventory into a batch for processing.",
    to: "/seller-pricer",
    icon: StorefrontIcon,
  },
  {
    title: "Inventory Manager",
    description: "Review and add inventory entries after catalog work is done.",
    to: "/inventory-manager",
    icon: Inventory2Icon,
  },
];

const setupShortcuts: ShortcutLink[] = [
  {
    title: "Pricing Configuration",
    description: "Adjust the rules that downstream pricing tools depend on.",
    to: "/configuration",
    icon: SettingsIcon,
  },
  {
    title: "HTTP Configuration",
    description: "Update the TCGPlayer auth cookie required for live catalog calls.",
    to: "/http-configuration",
    icon: HttpIcon,
  },
];

const maintenancePlaybook = [
  "Refresh product lines first when TCGPlayer adds or reshapes categories.",
  "Sync a full product line when you want complete set, product, and SKU coverage.",
  "Hydrate a single set when a release lands and you only need that slice ready.",
  "Repair a single product when one listing drifts or gets reclassified.",
];

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
    <Box sx={{ maxWidth: 1480, mx: "auto", p: { xs: 2, md: 3 } }}>
      <Paper
        elevation={0}
        sx={(theme) => ({
          p: { xs: 2.5, md: 4 },
          mb: 3,
          borderRadius: 4,
          color: theme.palette.common.white,
          background: `linear-gradient(135deg, ${theme.palette.grey[900]} 0%, ${theme.palette.primary.dark} 55%, ${theme.palette.info.dark} 100%)`,
          boxShadow: `0 24px 60px ${alpha(theme.palette.common.black, 0.24)}`,
        })}
      >
        <Stack
          direction={{ xs: "column", lg: "row" }}
          spacing={3}
          justifyContent="space-between"
        >
          <Box sx={{ maxWidth: 760 }}>
            <Typography
              variant="overline"
              sx={{ letterSpacing: "0.18em", opacity: 0.8 }}
            >
              Catalog Maintenance
            </Typography>
            <Typography variant="h3" component="h1" sx={{ mt: 1, mb: 1.5 }}>
              Data Management
            </Typography>
            <Typography
              variant="body1"
              sx={{ maxWidth: 680, opacity: 0.9, lineHeight: 1.7 }}
            >
              Keep the local catalog trustworthy by refreshing the right slice at
              the right time. This workspace is now organized around readiness,
              focused maintenance jobs, and feedback that stays attached to the
              action that produced it.
            </Typography>
            <Stack
              direction="row"
              spacing={1}
              flexWrap="wrap"
              useFlexGap
              sx={{ mt: 2.5 }}
            >
              <Chip
                icon={hasAuthCookie ? <CheckCircleIcon /> : <ErrorOutlineIcon />}
                label={hasAuthCookie ? "TCGPlayer Auth Ready" : "Auth Cookie Missing"}
                color={hasAuthCookie ? "success" : "warning"}
                variant="filled"
              />
              <Chip
                icon={<StorageIcon />}
                label={`${productLines.length} product lines available`}
                sx={{ bgcolor: alpha("#ffffff", 0.14), color: "inherit" }}
              />
            </Stack>
          </Box>

          <Paper
            elevation={0}
            sx={{
              p: 2.5,
              minWidth: { lg: 360 },
              alignSelf: "stretch",
              borderRadius: 3,
              bgcolor: alpha("#ffffff", 0.1),
              border: "1px solid",
              borderColor: alpha("#ffffff", 0.16),
              backdropFilter: "blur(10px)",
            }}
          >
            <Typography variant="h6" gutterBottom>
              Recommended rhythm
            </Typography>
            <Typography
              variant="body2"
              sx={{ opacity: 0.85, mb: 2, lineHeight: 1.7 }}
            >
              Use the lightest job that fixes the current problem. That keeps the
              page fast, the database clean, and the intent obvious.
            </Typography>
            <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
              {maintenancePlaybook.map((step) => (
                <Typography
                  component="li"
                  key={step}
                  variant="body2"
                  sx={{ mb: 1.25, lineHeight: 1.6 }}
                >
                  {step}
                </Typography>
              ))}
            </Box>
          </Paper>
        </Stack>
      </Paper>

      {!hasAuthCookie && (
        <Alert
          severity="warning"
          sx={{ mb: 3, borderRadius: 3 }}
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
          gridTemplateColumns: { xs: "1fr", xl: "1.2fr 0.8fr" },
          gap: 3,
          mb: 3,
        }}
      >
        <Paper
          elevation={2}
          sx={{ p: 3, borderRadius: 4, overflow: "hidden" }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
            <AutoAwesomeIcon color="primary" />
            <Typography variant="h5">Quick access</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Jump into the workflows most likely to follow catalog maintenance.
          </Typography>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "1fr",
                md: "repeat(2, minmax(0, 1fr))",
                xl: "repeat(3, minmax(0, 1fr))",
              },
              gap: 2,
            }}
          >
            {workflowShortcuts.map((shortcut) => (
              <ShortcutCard key={shortcut.to} shortcut={shortcut} />
            ))}
          </Box>
        </Paper>

        <Paper elevation={2} sx={{ p: 3, borderRadius: 4 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
            <SettingsIcon color="primary" />
            <Typography variant="h5">Readiness</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            These inputs directly affect whether catalog refresh jobs can run
            cleanly.
          </Typography>

          <Stack spacing={2}>
            <ReadinessRow
              label="Authentication"
              value={hasAuthCookie ? "Ready for live catalog calls" : "Needs attention"}
              tone={hasAuthCookie ? "success" : "warning"}
              helper="Live TCGPlayer endpoints depend on the stored auth cookie."
            />
            <ReadinessRow
              label="Catalog foundation"
              value={
                productLines.length > 0
                  ? `${productLines.length} product lines in the database`
                  : "No product lines loaded yet"
              }
              tone={productLines.length > 0 ? "success" : "warning"}
              helper="Refresh product lines whenever TCGPlayer changes available categories."
            />
          </Stack>

          <Box sx={{ mt: 3, display: "grid", gap: 1.5 }}>
            {setupShortcuts.map((shortcut) => (
              <Button
                key={shortcut.to}
                component={Link}
                to={shortcut.to}
                variant="outlined"
                fullWidth
                startIcon={<shortcut.icon />}
                sx={{ justifyContent: "flex-start", py: 1.25 }}
              >
                {shortcut.title}
              </Button>
            ))}
          </Box>
        </Paper>
      </Box>

      <Typography variant="h4" component="h2" sx={{ mb: 1 }}>
        Maintenance jobs
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Each job has its own scope and its own result panel, so you can move with
        confidence instead of guessing which response came from which action.
      </Typography>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "repeat(2, minmax(0, 1fr))" },
          gap: 3,
        }}
      >
        <MaintenanceActionCard
          eyebrow="Foundation"
          title="Refresh product lines"
          description="Pull the current list of TCGPlayer product lines and category filters before deeper maintenance."
          icon={SyncAltIcon}
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
          eyebrow="Broad sync"
          title="Sync one product line"
          description="Rebuild sets, set products, products, and SKUs for a selected category when you need full coverage."
          icon={StorageIcon}
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
          eyebrow="Targeted repair"
          title="Repair one product"
          description="Refetch a single product and its SKUs when one listing is wrong, missing, or tied to the wrong set."
          icon={ManageSearchIcon}
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
          eyebrow="Release support"
          title="Hydrate one set"
          description="Fetch set products and SKUs directly from TCGPlayer, even if the set is not fully represented locally yet."
          icon={AutoAwesomeIcon}
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

function ShortcutCard({ shortcut }: { shortcut: ShortcutLink }) {
  return (
    <Card
      variant="outlined"
      sx={{
        height: "100%",
        borderRadius: 3,
        transition: "transform 180ms ease, box-shadow 180ms ease",
        "&:hover": {
          transform: "translateY(-2px)",
          boxShadow: 3,
        },
      }}
    >
      <CardContent sx={{ height: "100%" }}>
        <Stack spacing={2} sx={{ height: "100%" }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              sx={(theme) => ({
                display: "inline-flex",
                p: 1.2,
                borderRadius: 2.5,
                bgcolor: alpha(theme.palette.primary.main, 0.12),
                color: "primary.main",
              })}
            >
              <shortcut.icon />
            </Box>
            <Typography variant="h6">{shortcut.title}</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
            {shortcut.description}
          </Typography>
          <Button component={Link} to={shortcut.to} variant="text" sx={{ px: 0 }}>
            Open {shortcut.title}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function ReadinessRow({
  label,
  value,
  helper,
  tone,
}: {
  label: string;
  value: string;
  helper: string;
  tone: "success" | "warning";
}) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, borderRadius: 3, bgcolor: "background.default" }}
    >
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        spacing={1}
      >
        <Box>
          <Typography variant="subtitle2">{label}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {helper}
          </Typography>
        </Box>
        <Chip
          color={tone}
          label={value}
          icon={tone === "success" ? <CheckCircleIcon /> : <ErrorOutlineIcon />}
          sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
        />
      </Stack>
    </Paper>
  );
}

function MaintenanceActionCard({
  eyebrow,
  title,
  description,
  icon: Icon,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: SvgIconComponent;
  children: ReactNode;
}) {
  return (
    <Paper elevation={2} sx={{ p: 3, borderRadius: 4, height: "100%" }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box
            sx={(theme) => ({
              display: "inline-flex",
              p: 1.3,
              borderRadius: 3,
              bgcolor: alpha(theme.palette.primary.main, 0.12),
              color: "primary.main",
            })}
          >
            <Icon />
          </Box>
          <Box>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ letterSpacing: "0.14em" }}
            >
              {eyebrow}
            </Typography>
            <Typography variant="h5">{title}</Typography>
          </Box>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
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
      <Alert severity="info" sx={{ mt: 2, borderRadius: 3 }}>
        Request in progress. This panel will keep the result attached to this job.
      </Alert>
    );
  }

  if (fetcher.data?.error) {
    return (
      <Alert severity="error" sx={{ mt: 2, borderRadius: 3 }}>
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
      <Alert severity="success" sx={{ mt: 2, borderRadius: 3 }}>
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
      sx={{ mt: 2, p: 2, borderRadius: 3, bgcolor: "background.default" }}
    >
      <Typography variant="body2" color="text.secondary">
        {idleMessage}
      </Typography>
    </Paper>
  );
}
