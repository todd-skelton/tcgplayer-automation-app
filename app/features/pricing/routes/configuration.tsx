import React from "react";
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Stack,
  Alert,
  FormControl,
  FormLabel,
  FormControlLabel,
  Switch,
  Autocomplete,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Checkbox,
  MenuItem,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import { Link, data, useLoaderData, useFetcher } from "react-router";
import { useConfiguration } from "../hooks/useConfiguration";
import { getHttpConfig } from "~/core/config/httpConfig.server";
import type { ProductLine } from "~/shared/data-types/productLine";
import {
  isValidProfitPerDaySetting,
  type ProfitPerDaySettings,
} from "../types/config";

const PROFIT_PER_DAY_FIELDS: Array<{
  key: keyof ProfitPerDaySettings;
  label: string;
  step: number;
  helperText: string;
}> = [
  {
    key: "dailyReturnHurdle",
    label: "Daily return hurdle",
    step: 0.001,
    helperText:
      "Fraction of capital earned per day when proceeds are redeployed; 0.005 is 0.5% per day",
  },
  {
    key: "relativeOverhead",
    label: "Relative overhead",
    step: 0.01,
    helperText: "Share of each sale lost to fees",
  },
  {
    key: "staticOverheadPerUnit",
    label: "Static overhead per item",
    step: 0.05,
    helperText: "Dollars lost per unit sold",
  },
];

/** Number field that keeps what was typed and saves each complete valid value. */
function ValidatedNumberField({
  label,
  value,
  step,
  helperText,
  isValid,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  helperText: string;
  isValid: (value: number) => boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);
  const accepts = (input: string) =>
    input !== "" && Number.isFinite(Number(input)) && isValid(Number(input));
  return (
    <TextField
      label={label}
      type="number"
      value={text}
      error={text !== "" && !accepts(text)}
      onChange={(event) => {
        setText(event.target.value);
        if (accepts(event.target.value)) onCommit(Number(event.target.value));
      }}
      inputProps={{ step }}
      helperText={helperText}
    />
  );
}

export async function loader() {
  const httpConfig = await getHttpConfig();
  return data({ httpConfig });
}

export default function ConfigurationRoute() {
  const {
    config,
    updatePricingConfig,
    updateSupplyAnalysisConfig,
    updateFileConfig,
    updateFormDefaults,
    resetToDefaults,
    productLinePricing,
  } = useConfiguration();
  const { httpConfig } = useLoaderData<typeof loader>();
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  const [successMessage, setSuccessMessage] = React.useState<string>("");

  // Product line fetching and state
  const productLinesFetcher = useFetcher<ProductLine[]>();
  const [selectedProductLine, setSelectedProductLine] =
    React.useState<ProductLine | null>(null);
  const [newPercentile, setNewPercentile] = React.useState<number>(
    config.pricing.defaultPercentile,
  );
  const [newSkip, setNewSkip] = React.useState<boolean>(false);
  const [newHurdle, setNewHurdle] = React.useState("");
  const newHurdleValue = newHurdle === "" ? undefined : Number(newHurdle);
  const newHurdleValid =
    newSkip ||
    newHurdleValue === undefined ||
    isValidProfitPerDaySetting.dailyReturnHurdle(newHurdleValue);

  React.useEffect(() => {
    setNewPercentile(config.pricing.defaultPercentile);
  }, [config.pricing.defaultPercentile]);

  // Fetch product lines on mount
  React.useEffect(() => {
    if (productLinesFetcher.state === "idle" && !productLinesFetcher.data) {
      productLinesFetcher.load("/api/inventory/product-lines");
    }
  }, [productLinesFetcher]);

  const productLines = productLinesFetcher.data || [];
  const sortedProductLines = [...productLines].sort((a, b) =>
    a.productLineName.localeCompare(b.productLineName),
  );

  // Get product line name by ID (for display in table)
  const getProductLineName = (productLineId: number): string => {
    const pl = productLines.find((p) => p.productLineId === productLineId);
    return pl?.productLineName || `Product Line ${productLineId}`;
  };

  // Get configured product line IDs
  const configuredProductLineIds = Object.keys(
    config.productLinePricing.productLineSettings,
  ).map(Number);

  // Filter out already-configured product lines from selector
  const availableProductLines = sortedProductLines.filter(
    (pl) => !configuredProductLineIds.includes(pl.productLineId),
  );

  const handleAddProductLineSetting = () => {
    if (!selectedProductLine) return;

    productLinePricing.setProductLineSettings(
      selectedProductLine.productLineId,
      {
        percentile: newPercentile,
        skip: newSkip,
        ...(newSkip || newHurdleValue === undefined
          ? {}
          : { dailyReturnHurdle: newHurdleValue }),
      },
    );

    // Reset form
    setSelectedProductLine(null);
    setNewPercentile(config.pricing.defaultPercentile);
    setNewSkip(false);
    setNewHurdle("");
    setSuccessMessage("Product line pricing added");
    setTimeout(() => setSuccessMessage(""), 2000);
  };

  const handleRemoveProductLineSetting = (productLineId: number) => {
    productLinePricing.removeProductLineSettings(productLineId);
    setSuccessMessage("Product line pricing removed");
    setTimeout(() => setSuccessMessage(""), 2000);
  };

  const handleDefaultPercentileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = Number(event.target.value);
    productLinePricing.setDefaultPercentile(value);
    setSuccessMessage("Default percentile updated");
    setTimeout(() => setSuccessMessage(""), 2000);
  };

  const handlePricingConfigChange =
    (field: keyof typeof config.pricing) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        event.target.type === "number"
          ? Number(event.target.value)
          : event.target.value;
      updatePricingConfig({ [field]: value });
      setSuccessMessage("Configuration updated");
      setTimeout(() => setSuccessMessage(""), 2000);
    };

  const handleSupplyAnalysisConfigChange =
    (field: keyof typeof config.supplyAnalysis) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        event.target.type === "number"
          ? Number(event.target.value)
          : event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value;
      updateSupplyAnalysisConfig({ [field]: value });
      setSuccessMessage("Configuration updated");
      setTimeout(() => setSuccessMessage(""), 2000);
    };

  const handleFileConfigChange =
    (field: keyof typeof config.file) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      updateFileConfig({ [field]: event.target.value });
      setSuccessMessage("Configuration updated");
      setTimeout(() => setSuccessMessage(""), 2000);
    };

  const handleFormDefaultsChange =
    (field: keyof typeof config.formDefaults) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        event.target.type === "number"
          ? Number(event.target.value)
          : event.target.value;
      updateFormDefaults({ [field]: value });
      setSuccessMessage("Configuration updated");
      setTimeout(() => setSuccessMessage(""), 2000);
    };

  const handleSuccessRateThresholdChange =
    (field: keyof typeof config.pricing.successRateThreshold) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      updatePricingConfig({
        successRateThreshold: {
          ...config.pricing.successRateThreshold,
          [field]: value,
        },
      });
      setSuccessMessage("Configuration updated");
      setTimeout(() => setSuccessMessage(""), 2000);
    };

  const handleReset = () => {
    if (showResetConfirm) {
      resetToDefaults();
      setShowResetConfirm(false);
      setSuccessMessage("Configuration reset to defaults");
      setTimeout(() => setSuccessMessage(""), 3000);
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 5000);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Configuration Settings
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Pricing, supply analysis, and product line settings are saved to the server so background pricing jobs use the same configuration. File and form defaults remain local to this browser.
      </Typography>

      {!httpConfig.tcgAuthCookie && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <Typography variant="body2" gutterBottom>
            <strong>Authentication Required:</strong> You haven't configured
            your TCGPlayer auth cookie yet.
          </Typography>
          <Button
            component={Link}
            to="/http-configuration"
            variant="outlined"
            size="small"
            sx={{ mt: 1 }}
          >
            Configure HTTP Settings
          </Button>
        </Alert>
      )}

      {successMessage && (
        <Alert severity="success" sx={{ mb: 3 }}>
          {successMessage}
        </Alert>
      )}

      {/* Pricing Configuration */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Pricing Configuration
        </Typography>
        <Stack spacing={3}>
          <TextField
            select
            label="Active Pricing Policy"
            value={config.pricing.policy.method}
            onChange={(event) =>
              updatePricingConfig({
                policy:
                  event.target.value === "target-horizon"
                    ? { method: "target-horizon", horizonDays: 33.5 }
                    : event.target.value === "profit-per-day"
                      ? { method: "profit-per-day" }
                      : { method: "percentile" },
              })
            }
            helperText="Percentile uses the product-line settings below. Target horizon applies one median sell-time target across inventory. Profit per day prices each SKU where net proceeds, discounted at the daily return hurdle over its sell time, are highest."
          >
            <MenuItem value="percentile">Configured percentile</MenuItem>
            <MenuItem value="target-horizon">Target sell horizon</MenuItem>
            <MenuItem value="profit-per-day">Profit per day</MenuItem>
          </TextField>

          {config.pricing.policy.method === "target-horizon" && (
            <ValidatedNumberField
              label="Target Median Sell Time (days)"
              value={config.pricing.policy.horizonDays}
              step={0.1}
              helperText="Calibrate this value from the complete inventory portfolio; continuous pricing keeps it fixed as markets move."
              isValid={(horizonDays) => horizonDays > 0}
              onCommit={(horizonDays) =>
                updatePricingConfig({
                  policy: { method: "target-horizon", horizonDays },
                })
              }
            />
          )}

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Profit per day settings
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Used by the profit-per-day policy and by the inventory strategy
              dashboard's profit-per-day row.
            </Typography>
            <Box sx={{ display: "flex", gap: 2 }}>
              {PROFIT_PER_DAY_FIELDS.map((field) => (
                <ValidatedNumberField
                  key={field.key}
                  label={field.label}
                  value={config.pricing.profitPerDay[field.key]}
                  step={field.step}
                  helperText={field.helperText}
                  isValid={isValidProfitPerDaySetting[field.key]}
                  onCommit={(value) =>
                    updatePricingConfig({
                      profitPerDay: {
                        ...config.pricing.profitPerDay,
                        [field.key]: value,
                      },
                    })
                  }
                />
              ))}
            </Box>
          </Box>

          <TextField
            label="Default Percentile"
            type="number"
            value={config.pricing.defaultPercentile}
            onChange={handlePricingConfigChange("defaultPercentile")}
            inputProps={{ min: 0, max: 100 }}
            helperText="Default percentile for pricing calculations"
          />

          <Box sx={{ display: "flex", gap: 2 }}>
            <TextField
              label="Min Percentile"
              type="number"
              value={config.pricing.minPercentile}
              onChange={handlePricingConfigChange("minPercentile")}
              inputProps={{ min: 0, max: 100 }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Max Percentile"
              type="number"
              value={config.pricing.maxPercentile}
              onChange={handlePricingConfigChange("maxPercentile")}
              inputProps={{ min: 0, max: 100 }}
              sx={{ flex: 1 }}
            />
          </Box>

          <TextField
            label="Percentile Step"
            type="number"
            value={config.pricing.percentileStep}
            onChange={handlePricingConfigChange("percentileStep")}
            inputProps={{ min: 1, max: 20 }}
            helperText="Step size for percentile calculations"
          />

          <TextField
            label="Skip Prefix"
            value={config.pricing.skipPrefix}
            onChange={handlePricingConfigChange("skipPrefix")}
            helperText="Prefix to identify items to skip during processing"
          />

          <Box sx={{ display: "flex", gap: 2 }}>
            <TextField
              label="Min Price Multiplier"
              type="number"
              value={config.pricing.minPriceMultiplier}
              onChange={handlePricingConfigChange("minPriceMultiplier")}
              inputProps={{ min: 0, max: 2, step: 0.01 }}
              sx={{ flex: 1 }}
              helperText="Multiplier for minimum price calculation"
            />
            <TextField
              label="Min Price Constant"
              type="number"
              value={config.pricing.minPriceConstant}
              onChange={handlePricingConfigChange("minPriceConstant")}
              inputProps={{ min: 0, max: 1, step: 0.01 }}
              sx={{ flex: 1 }}
              helperText="Constant added to minimum price"
            />
          </Box>

          <FormControl>
            <FormLabel component="legend">Success Rate Thresholds</FormLabel>
            <Box sx={{ display: "flex", gap: 2, mt: 1 }}>
              <TextField
                label="Low Threshold"
                type="number"
                value={config.pricing.successRateThreshold.low}
                onChange={(e) =>
                  updatePricingConfig({
                    successRateThreshold: {
                      ...config.pricing.successRateThreshold,
                      low: Number(e.target.value),
                    },
                  })
                }
                inputProps={{ min: 0, max: 100 }}
                sx={{ flex: 1 }}
              />
              <TextField
                label="High Threshold"
                type="number"
                value={config.pricing.successRateThreshold.high}
                onChange={(e) =>
                  updatePricingConfig({
                    successRateThreshold: {
                      ...config.pricing.successRateThreshold,
                      high: Number(e.target.value),
                    },
                  })
                }
                inputProps={{ min: 0, max: 100 }}
                sx={{ flex: 1 }}
              />
            </Box>
          </FormControl>
        </Stack>
      </Paper>

      {/* Product Line Pricing Configuration */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Product Line Pricing
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Configure a different percentile or profit-per-day hurdle for specific
          product lines. You can also skip product lines entirely.
          Non-configured product lines use the defaults.
        </Typography>

        <Stack spacing={3}>
          <TextField
            label="Default Percentile for Non-Configured Lines"
            type="number"
            value={config.productLinePricing.defaultPercentile}
            onChange={handleDefaultPercentileChange}
            inputProps={{
              min: config.pricing.minPercentile,
              max: config.pricing.maxPercentile,
            }}
            helperText="Percentile used for product lines not explicitly configured below"
          />

          {/* Add new product line setting */}
          <Box
            sx={{
              p: 2,
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 1,
            }}
          >
            <Typography variant="subtitle2" gutterBottom>
              Add Product Line Configuration
            </Typography>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={2}
              alignItems="flex-start"
            >
              <Autocomplete
                options={availableProductLines}
                getOptionLabel={(option) => option.productLineName}
                value={selectedProductLine}
                onChange={(_, newValue) => setSelectedProductLine(newValue)}
                sx={{ minWidth: 250, flex: 1 }}
                loading={productLinesFetcher.state === "loading"}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Select Product Line"
                    placeholder="Search product lines..."
                    size="small"
                  />
                )}
              />
              <TextField
                label="Percentile"
                type="number"
                value={newPercentile}
                onChange={(e) => setNewPercentile(Number(e.target.value))}
                inputProps={{
                  min: config.pricing.minPercentile,
                  max: config.pricing.maxPercentile,
                }}
                size="small"
                sx={{ width: 120 }}
                disabled={newSkip}
              />
              <TextField
                label="Daily return hurdle"
                type="number"
                value={newHurdle}
                onChange={(e) => setNewHurdle(e.target.value)}
                error={!newHurdleValid}
                placeholder={String(
                  config.pricing.profitPerDay.dailyReturnHurdle,
                )}
                helperText="Blank uses the default"
                inputProps={{ step: 0.001 }}
                size="small"
                sx={{ width: 160 }}
                disabled={newSkip}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={newSkip}
                    onChange={(e) => setNewSkip(e.target.checked)}
                    size="small"
                  />
                }
                label="Skip"
              />
              <Button
                variant="contained"
                onClick={handleAddProductLineSetting}
                disabled={!selectedProductLine || !newHurdleValid}
                size="small"
              >
                Add
              </Button>
            </Stack>
          </Box>

          {/* Configured product lines table */}
          {configuredProductLineIds.length > 0 ? (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Product Line</TableCell>
                    <TableCell align="center">Percentile</TableCell>
                    <TableCell align="center">Daily return hurdle</TableCell>
                    <TableCell align="center">Skip</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {configuredProductLineIds.map((productLineId) => {
                    const settings =
                      config.productLinePricing.productLineSettings[
                        productLineId
                      ];
                    return (
                      <TableRow key={productLineId}>
                        <TableCell>
                          {getProductLineName(productLineId)}
                        </TableCell>
                        <TableCell align="center">
                          {settings.skip ? "—" : settings.percentile}
                        </TableCell>
                        <TableCell align="center">
                          {settings.skip
                            ? "—"
                            : (settings.dailyReturnHurdle ?? "—")}
                        </TableCell>
                        <TableCell align="center">
                          {settings.skip ? "Yes" : "No"}
                        </TableCell>
                        <TableCell align="right">
                          <IconButton
                            size="small"
                            onClick={() =>
                              handleRemoveProductLineSetting(productLineId)
                            }
                            color="error"
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Alert severity="info">
              No product lines configured. All product lines will use the
              default percentile ({config.productLinePricing.defaultPercentile}
              ).
            </Alert>
          )}
        </Stack>
      </Paper>

      {/* Supply Analysis Configuration */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Supply Analysis Configuration
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Configure market-adjusted time-to-sell calculations. When enabled,
          this feature fetches current market listings to provide more accurate
          time-to-sell estimates by considering market supply alongside
          historical sales data.
          <br />
          <strong>Note:</strong> Enabling this feature significantly increases
          network calls (1 listing API call per SKU).
        </Typography>

        <Stack spacing={3}>
          <FormControlLabel
            control={
              <Switch
                checked={config.supplyAnalysis.enableSupplyAnalysis}
                onChange={handleSupplyAnalysisConfigChange(
                  "enableSupplyAnalysis",
                )}
              />
            }
            label="Enable Supply Analysis"
            sx={{ mb: 1 }}
          />

          {config.supplyAnalysis.enableSupplyAnalysis && (
            <>
              <Alert severity="info" sx={{ mt: 2 }}>
                Supply analysis is enabled. This will increase processing time
                and network usage but provides more accurate time-to-sell
                estimates by analyzing current market supply.
              </Alert>

              <FormControlLabel
                control={
                  <Switch
                    checked={config.supplyAnalysis.includeUnverifiedSellers}
                    onChange={handleSupplyAnalysisConfigChange(
                      "includeUnverifiedSellers",
                    )}
                  />
                }
                label="Include Unverified Sellers"
                sx={{ mt: 1 }}
              />
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ ml: 4, mt: -1 }}
              >
                When enabled, includes listings from all sellers in the
                analysis. When disabled, only verified sellers are considered
                (recommended for quality).
              </Typography>
            </>
          )}
        </Stack>
      </Paper>

      {/* File Configuration */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          File Configuration
        </Typography>
        <Stack spacing={3}>
          <TextField
            label="File Accept Pattern"
            value={config.file.accept}
            onChange={handleFileConfigChange("accept")}
            helperText="File types accepted for upload (e.g., .csv)"
          />
          <TextField
            label="Output File Prefix"
            value={config.file.outputPrefix}
            onChange={handleFileConfigChange("outputPrefix")}
            helperText="Prefix for generated output files"
          />
          <TextField
            label="MIME Type"
            value={config.file.mimeType}
            onChange={handleFileConfigChange("mimeType")}
            helperText="MIME type for generated files"
          />
        </Stack>
      </Paper>

      {/* Form Defaults */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Form Defaults
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          These values will be pre-filled in forms and updated when you submit
          forms.
        </Typography>
        <Stack spacing={3}>
          <TextField
            label="Default Percentile for Forms"
            type="number"
            value={config.formDefaults.percentile}
            onChange={handleFormDefaultsChange("percentile")}
            inputProps={{ min: 0, max: 100 }}
            helperText="Default percentile value in upload and seller forms"
          />
          <TextField
            label="Default Seller Key"
            value={config.formDefaults.sellerKey}
            onChange={handleFormDefaultsChange("sellerKey")}
            helperText="Default seller key (saved from last successful use)"
          />
        </Stack>
      </Paper>

      {/* Reset Configuration */}
      <Paper sx={{ p: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Reset Configuration
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Reset all configuration settings back to their original default
          values.
        </Typography>

        {showResetConfirm && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Click the Reset button again within 5 seconds to confirm. This
            action cannot be undone.
          </Alert>
        )}

        <Button
          variant={showResetConfirm ? "contained" : "outlined"}
          color={showResetConfirm ? "error" : "secondary"}
          onClick={handleReset}
        >
          {showResetConfirm ? "Confirm Reset to Defaults" : "Reset to Defaults"}
        </Button>
      </Paper>
    </Box>
  );
}
