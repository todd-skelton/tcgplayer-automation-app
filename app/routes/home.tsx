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
import { productLinesRepository } from "../core/db";
import { getHttpConfig } from "../core/config/httpConfig.server";
import { runCatalogMaintenance } from "../features/catalog-sync/services/catalogMaintenance.server";

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
  const { status, body } = await runCatalogMaintenance((name) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : null;
  });
  return data(body, { status });
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
  const syncNewProductsFetcher = useFetcher<typeof action>();
  const syncProductLineFetcher = useFetcher<typeof action>();
  const repairProductFetcher = useFetcher<typeof action>();
  const hydrateSetFetcher = useFetcher<typeof action>();
  const { productLines, hasAuthCookie } = useLoaderData<typeof loader>();

  const [newProductsLineId, setNewProductsLineId] = useState<number | "">("");
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

    setNewProductsLineId((currentValue) => {
      const stillValid = productLines.some(
        (productLine) => productLine.productLineId === currentValue,
      );
      return stillValid ? currentValue : firstProductLine.productLineId;
    });

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
          title="Sync new products"
          description="Compare every set's product count with TCGplayer, then fetch only the sets that changed and only their missing products and SKUs."
        >
          <syncNewProductsFetcher.Form method="post">
            <input type="hidden" name="actionType" value="syncNewProducts" />
            <Stack spacing={2}>
              <FormControl fullWidth>
                <InputLabel id="sync-new-products-line-label">Product line</InputLabel>
                <Select
                  labelId="sync-new-products-line-label"
                  name="categoryId"
                  value={newProductsLineId}
                  label="Product line"
                  onChange={(event) =>
                    setNewProductsLineId(Number(event.target.value))
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
                Use this after new sets release or when promo sets grow. New
                SKUs on products you already have are not detected; use Repair
                one product for those.
              </Typography>

              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={
                  !newProductsLineId || syncNewProductsFetcher.state !== "idle"
                }
              >
                {syncNewProductsFetcher.state === "idle"
                  ? "Sync New Products"
                  : "Syncing New Products..."}
              </Button>
            </Stack>
          </syncNewProductsFetcher.Form>
          <ActionFeedback
            fetcher={syncNewProductsFetcher}
            idleMessage="Unchanged sets are skipped after two quick TCGplayer requests: the set list and the per-set counts."
          />
        </MaintenanceActionCard>

        <MaintenanceActionCard
          title="Check every product in a product line"
          description="Walk every stored product in a category, fetching sets with no products and products with no SKUs. Slow on large product lines."
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
                  ? "Check Every Product"
                  : "Checking Every Product..."}
              </Button>
            </Stack>
          </syncProductLineFetcher.Form>
          <ActionFeedback
            fetcher={syncProductLineFetcher}
            idleMessage="Use Sync new products first; this full pass is the fallback when a whole category needs reconciliation."
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
