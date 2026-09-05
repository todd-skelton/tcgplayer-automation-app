import React, { useCallback, useEffect, useMemo, useState } from "react";
import SearchIcon from "@mui/icons-material/Search";
import PriceCheckIcon from "@mui/icons-material/PriceCheck";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { CategorySet } from "~/shared/data-types/categorySet";
import type { ProductLine } from "~/shared/data-types/productLine";
import type {
  ProductPriceMatrixProduct,
  ProductPriceMatrixProductsResponse,
  ProductPriceMatrixResponse,
  ProductPriceMatrixSearchScope,
} from "../types/productPriceMatrix";
import { ConditionRefundHelper } from "../components/ConditionRefundHelper";
import { describePricingPolicy } from "~/features/pricing/components/policyLabel";
import { ProductPriceMatrixTable } from "../components/ProductPriceMatrixTable";

const DEFAULT_PRODUCT_LINE_ID = 3;

type ProductTypeFilter = "all" | "sealed" | "unsealed";

type ErrorPayload = {
  error?: string;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & ErrorPayload;

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }

  return payload;
}

function sortSets(sets: CategorySet[]): CategorySet[] {
  return [...sets]
    .filter((set) => !set.name.startsWith("[Inactive"))
    .sort((left, right) => {
      if (!left.releaseDate && !right.releaseDate) {
        return left.name.localeCompare(right.name);
      }

      if (!left.releaseDate) {
        return 1;
      }

      if (!right.releaseDate) {
        return -1;
      }

      return (
        new Date(right.releaseDate).getTime() -
        new Date(left.releaseDate).getTime()
      );
    });
}

function getSetLabel(set: CategorySet): string {
  const abbreviation = set.abbreviation ? `${set.abbreviation} - ` : "";
  const releaseDate = set.releaseDate
    ? ` - ${new Date(set.releaseDate).toLocaleDateString()}`
    : "";

  return `${abbreviation}${set.name}${releaseDate}`;
}

function getProductLabel(product: ProductPriceMatrixProduct): string {
  const cardNumber = product.cardNumber ? `${product.cardNumber} - ` : "";
  return `${cardNumber}${product.productName} - ${product.setName}`;
}

function getDefaultLanguage(product: ProductPriceMatrixProduct): string {
  return product.languages.includes("English")
    ? "English"
    : (product.languages[0] ?? "");
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "N/A";
  }

  return new Date(value).toLocaleString();
}

export default function ProductPriceMatrixRoute() {
  const [productLines, setProductLines] = useState<ProductLine[]>([]);
  const [sets, setSets] = useState<CategorySet[]>([]);
  const [products, setProducts] = useState<ProductPriceMatrixProduct[]>([]);
  const [selectedProductLineId, setSelectedProductLineId] = useState<
    number | null
  >(null);
  const [selectedSetId, setSelectedSetId] = useState<number | null>(null);
  const [searchScope, setSearchScope] =
    useState<ProductPriceMatrixSearchScope>("set");
  const [allSetsCardNumber, setAllSetsCardNumber] = useState("");
  const [productTypeFilter, setProductTypeFilter] =
    useState<ProductTypeFilter>("unsealed");
  const [selectedProduct, setSelectedProduct] =
    useState<ProductPriceMatrixProduct | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [matrix, setMatrix] = useState<ProductPriceMatrixResponse | null>(null);
  const [isLoadingProductLines, setIsLoadingProductLines] = useState(false);
  const [isLoadingSets, setIsLoadingSets] = useState(false);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isLoadingMatrix, setIsLoadingMatrix] = useState(false);
  const [isCalculatingSuggested, setIsCalculatingSuggested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProductLine =
    productLines.find(
      (productLine) => productLine.productLineId === selectedProductLineId,
    ) ?? null;
  const selectedSet =
    sets.find((set) => set.setNameId === selectedSetId) ?? null;
  const visibleProducts = useMemo(
    () =>
      products.filter((product) => {
        if (productTypeFilter === "sealed") {
          return product.sealed;
        }

        if (productTypeFilter === "unsealed") {
          return !product.sealed;
        }

        return true;
      }),
    [products, productTypeFilter],
  );
  const loadProductOptions = useCallback(
    async ({
      productLineId,
      setId,
      scope,
      query,
    }: {
      productLineId: number;
      setId?: number | null;
      scope: ProductPriceMatrixSearchScope;
      query?: string;
    }) => {
      if (scope === "set" && !setId) {
        setProducts([]);
        return;
      }

      if (scope === "allSets" && !query?.trim()) {
        setProducts([]);
        return;
      }

      setIsLoadingProducts(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          productLineId: String(productLineId),
          scope,
        });

        if (scope === "set" && setId) {
          params.set("setId", String(setId));
        }

        if (query?.trim()) {
          params.set("query", query.trim());
        }

        const payload = await fetchJson<ProductPriceMatrixProductsResponse>(
          `/api/product-price-matrix/products?${params.toString()}`,
        );
        setProducts(payload.products);
      } catch (loadError) {
        setProducts([]);
        setError(String(loadError));
      } finally {
        setIsLoadingProducts(false);
      }
    },
    [],
  );

  const loadSets = useCallback(
    async (productLineId: number, scope: ProductPriceMatrixSearchScope) => {
      setIsLoadingSets(true);
      setError(null);

      try {
        const loadedSets = await fetchJson<CategorySet[]>(
          `/api/inventory/sets?productLineId=${productLineId}`,
        );
        const sortedSets = sortSets(loadedSets);
        const latestSet = sortedSets[0] ?? null;

        setSets(sortedSets);
        setSelectedSetId(latestSet?.setNameId ?? null);
        setSelectedProduct(null);
        setSelectedLanguage("");
        setMatrix(null);

        if (scope === "set" && latestSet) {
          await loadProductOptions({
            productLineId,
            setId: latestSet.setNameId,
            scope,
          });
        } else {
          setProducts([]);
        }
      } catch (loadError) {
        setSets([]);
        setProducts([]);
        setError(String(loadError));
      } finally {
        setIsLoadingSets(false);
      }
    },
    [loadProductOptions],
  );

  const loadMatrix = useCallback(
    async ({
      product,
      language,
      includeSuggestedPrices,
    }: {
      product: ProductPriceMatrixProduct;
      language: string;
      includeSuggestedPrices: boolean;
    }) => {
      setError(null);

      if (includeSuggestedPrices) {
        setIsCalculatingSuggested(true);
      } else {
        setIsLoadingMatrix(true);
        setMatrix(null);
      }

      try {
        const payload = await fetchJson<ProductPriceMatrixResponse>(
          "/api/product-price-matrix",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              productId: product.productId,
              productLineId: product.productLineId,
              language,
              includeSuggestedPrices,
            }),
          },
        );

        setMatrix(payload);
      } catch (loadError) {
        setError(String(loadError));
      } finally {
        if (includeSuggestedPrices) {
          setIsCalculatingSuggested(false);
        } else {
          setIsLoadingMatrix(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const loadInitialData = async () => {
      setIsLoadingProductLines(true);
      setError(null);

      try {
        const loadedProductLines = await fetchJson<ProductLine[]>(
          "/api/inventory/product-lines",
        );
        const sortedProductLines = [...loadedProductLines].sort((left, right) =>
          left.productLineName.localeCompare(right.productLineName),
        );
        const defaultProductLine =
          sortedProductLines.find(
            (productLine) =>
              productLine.productLineId === DEFAULT_PRODUCT_LINE_ID,
          ) ??
          sortedProductLines[0] ??
          null;

        setProductLines(sortedProductLines);

        if (defaultProductLine) {
          setSelectedProductLineId(defaultProductLine.productLineId);
          await loadSets(defaultProductLine.productLineId, "set");
        }
      } catch (loadError) {
        setError(String(loadError));
      } finally {
        setIsLoadingProductLines(false);
      }
    };

    void loadInitialData();
  }, [loadSets]);

  const handleProductLineChange = async (productLine: ProductLine | null) => {
    if (!productLine) {
      return;
    }

    setSelectedProductLineId(productLine.productLineId);
    setAllSetsCardNumber("");
    await loadSets(productLine.productLineId, searchScope);
  };

  const handleSetChange = async (set: CategorySet | null) => {
    if (!set || !selectedProductLineId) {
      return;
    }

    setSelectedSetId(set.setNameId);
    setSelectedProduct(null);
    setSelectedLanguage("");
    setMatrix(null);
    await loadProductOptions({
      productLineId: selectedProductLineId,
      setId: set.setNameId,
      scope: "set",
    });
  };

  const handleSearchScopeChange = async (
    nextScope: ProductPriceMatrixSearchScope,
  ) => {
    setSearchScope(nextScope);
    setAllSetsCardNumber("");
    setSelectedProduct(null);
    setSelectedLanguage("");
    setMatrix(null);

    if (nextScope === "set" && selectedProductLineId && selectedSetId) {
      await loadProductOptions({
        productLineId: selectedProductLineId,
        setId: selectedSetId,
        scope: nextScope,
      });
      return;
    }

    setProducts([]);
  };

  const handleAllSetsSearch = async () => {
    if (!selectedProductLineId) {
      return;
    }

    setSelectedProduct(null);
    setSelectedLanguage("");
    setMatrix(null);
    await loadProductOptions({
      productLineId: selectedProductLineId,
      scope: "allSets",
      query: allSetsCardNumber,
    });
  };

  const handleProductChange = async (
    product: ProductPriceMatrixProduct | null,
  ) => {
    setSelectedProduct(product);
    setMatrix(null);

    if (!product) {
      setSelectedLanguage("");
      return;
    }

    const language = getDefaultLanguage(product);
    setSelectedLanguage(language);
    await loadMatrix({
      product,
      language,
      includeSuggestedPrices: false,
    });
  };

  const handleLanguageChange = async (language: string) => {
    setSelectedLanguage(language);

    if (!selectedProduct) {
      return;
    }

    await loadMatrix({
      product: selectedProduct,
      language,
      includeSuggestedPrices: false,
    });
  };

  const handleRefreshMarketPrices = async () => {
    if (!selectedProduct || !selectedLanguage) {
      return;
    }

    await loadMatrix({
      product: selectedProduct,
      language: selectedLanguage,
      includeSuggestedPrices: false,
    });
  };

  const handleRunSuggestedPricing = async () => {
    if (!selectedProduct || !selectedLanguage) {
      return;
    }

    await loadMatrix({
      product: selectedProduct,
      language: selectedLanguage,
      includeSuggestedPrices: true,
    });
  };

  const productLoading =
    isLoadingProductLines || isLoadingSets || isLoadingProducts;
  const matrixBusy = isLoadingMatrix || isCalculatingSuggested;

  return (
    <Box sx={{ maxWidth: 1440, mx: "auto", p: 3 }}>
      <Stack spacing={3}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ md: "center" }}
        >
          <Box>
            <Typography variant="h4" component="h1" fontWeight={700}>
              Product Price Matrix
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Compare one product across conditions and variants.
            </Typography>
          </Box>

          {matrix && (
            <Stack
              direction="row"
              spacing={1}
              flexWrap="wrap"
              justifyContent="flex-end"
            >
              <Chip
                size="small"
                variant="outlined"
                label={`Priced ${formatDateTime(matrix.pricedAt)}`}
              />
              <Chip
                size="small"
                color={matrix.suggestedPricesIncluded ? "success" : "default"}
                variant={matrix.suggestedPricesIncluded ? "filled" : "outlined"}
                label={
                  matrix.suggestedPricesIncluded
                    ? "Suggested prices included"
                    : "Market prices only"
                }
              />
            </Stack>
          )}
        </Stack>

        <Paper sx={{ p: 3 }} elevation={3}>
          <Stack spacing={2.5}>
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              alignItems={{ md: "center" }}
            >
              <Autocomplete
                options={productLines}
                value={selectedProductLine}
                getOptionLabel={(option) => option.productLineName}
                onChange={(_, nextValue) =>
                  void handleProductLineChange(nextValue)
                }
                loading={isLoadingProductLines}
                sx={{ minWidth: 220, flex: 1 }}
                renderInput={(params) => (
                  <TextField {...params} label="Product Line" />
                )}
              />

              <FormControl sx={{ minWidth: 180 }}>
                <InputLabel>Product Type</InputLabel>
                <Select
                  value={productTypeFilter}
                  label="Product Type"
                  onChange={(event) =>
                    setProductTypeFilter(
                      event.target.value as ProductTypeFilter,
                    )
                  }
                >
                  <MenuItem value="all">All Products</MenuItem>
                  <MenuItem value="unsealed">Unsealed Only</MenuItem>
                  <MenuItem value="sealed">Sealed Only</MenuItem>
                </Select>
              </FormControl>

              <FormControlLabel
                control={
                  <Switch
                    checked={searchScope === "allSets"}
                    onChange={(_, checked) =>
                      void handleSearchScopeChange(checked ? "allSets" : "set")
                    }
                    disabled={!selectedProductLineId}
                  />
                }
                label="All sets"
                sx={{ mr: 0 }}
              />
            </Stack>

            <Stack
              direction={{ xs: "column", lg: "row" }}
              spacing={2}
              alignItems={{ lg: "center" }}
            >
              {searchScope === "set" ? (
                <Autocomplete
                  options={sets}
                  value={selectedSet}
                  getOptionLabel={getSetLabel}
                  onChange={(_, nextValue) => void handleSetChange(nextValue)}
                  loading={isLoadingSets}
                  disabled={!selectedProductLineId}
                  sx={{ minWidth: 280, flex: 1.1 }}
                  renderInput={(params) => (
                    <TextField {...params} label="Set" />
                  )}
                />
              ) : (
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1}
                  sx={{ minWidth: 280, flex: 1.1 }}
                >
                  <TextField
                    label="Card Number"
                    value={allSetsCardNumber}
                    onChange={(event) =>
                      setAllSetsCardNumber(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleAllSetsSearch();
                      }
                    }}
                    disabled={!selectedProductLineId}
                    sx={{ flex: 1 }}
                  />
                  <Button
                    variant="contained"
                    startIcon={<SearchIcon />}
                    onClick={() => void handleAllSetsSearch()}
                    disabled={
                      !selectedProductLineId ||
                      !allSetsCardNumber.trim() ||
                      isLoadingProducts
                    }
                  >
                    Search
                  </Button>
                </Stack>
              )}

              <Autocomplete
                options={visibleProducts}
                value={selectedProduct}
                getOptionLabel={getProductLabel}
                isOptionEqualToValue={(option, value) =>
                  option.productId === value.productId
                }
                onChange={(_, nextValue) => void handleProductChange(nextValue)}
                loading={isLoadingProducts}
                disabled={productLoading || visibleProducts.length === 0}
                sx={{ minWidth: 320, flex: 1.4 }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Product"
                    InputProps={{
                      ...params.InputProps,
                      endAdornment: (
                        <>
                          {isLoadingProducts ? (
                            <CircularProgress color="inherit" size={20} />
                          ) : null}
                          {params.InputProps.endAdornment}
                        </>
                      ),
                    }}
                  />
                )}
              />

              <FormControl sx={{ minWidth: 180 }}>
                <InputLabel>Language</InputLabel>
                <Select
                  value={selectedLanguage}
                  label="Language"
                  onChange={(event) =>
                    void handleLanguageChange(event.target.value)
                  }
                  disabled={!selectedProduct || matrixBusy}
                >
                  {(selectedProduct?.languages ?? []).map((language) => (
                    <MenuItem key={language} value={language}>
                      {language}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </Stack>
        </Paper>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {searchScope === "allSets" &&
          allSetsCardNumber.trim() &&
          !isLoadingProducts &&
          products.length === 0 && (
            <Alert severity="info">No matching products found.</Alert>
          )}

        {selectedProduct && (
          <Paper sx={{ p: 3 }} elevation={3}>
            <Stack spacing={2.5}>
              <Stack
                direction={{ xs: "column", lg: "row" }}
                spacing={2}
                justifyContent="space-between"
                alignItems={{ lg: "center" }}
              >
                <Stack spacing={1}>
                  <Typography variant="h5" component="h2" fontWeight={700}>
                    {selectedProduct.productName}
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    {selectedProduct.cardNumber && (
                      <Chip
                        size="small"
                        label={`#${selectedProduct.cardNumber}`}
                      />
                    )}
                    <Chip size="small" label={selectedProduct.setName} />
                    <Chip size="small" label={selectedProduct.rarityName} />
                    <Chip
                      size="small"
                      label={`${selectedProduct.skuCount} SKUs`}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={selectedLanguage || "No language"}
                    />
                    {matrix?.policy && (
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={describePricingPolicy(matrix.policy)}
                      />
                    )}
                  </Stack>
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <Button
                    variant="outlined"
                    startIcon={<RefreshIcon />}
                    onClick={() => void handleRefreshMarketPrices()}
                    disabled={matrixBusy || !selectedLanguage}
                  >
                    Refresh Market
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={
                      isCalculatingSuggested ? (
                        <CircularProgress color="inherit" size={18} />
                      ) : (
                        <PriceCheckIcon />
                      )
                    }
                    onClick={() => void handleRunSuggestedPricing()}
                    disabled={matrixBusy || !selectedLanguage}
                  >
                    Suggested Pricing
                  </Button>
                </Stack>
              </Stack>

              {isLoadingMatrix && (
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <CircularProgress size={20} />
                  <Typography variant="body2" color="text.secondary">
                    Loading market prices...
                  </Typography>
                </Stack>
              )}

              {matrix && matrix.cells.length > 0 && (
                <ProductPriceMatrixTable matrix={matrix} />
              )}

              {matrix &&
                matrix.suggestedPricesIncluded &&
                matrix.cells.length > 0 && (
                  <ConditionRefundHelper key={matrix.pricedAt} matrix={matrix} />
                )}

              {matrix && matrix.cells.length === 0 && (
                <Alert severity="info">
                  No SKUs are available for the selected language.
                </Alert>
              )}
            </Stack>
          </Paper>
        )}
      </Stack>
    </Box>
  );
}
