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
} from "@mui/material";
import { Link } from "react-router";
import { useConfiguration } from "../hooks/useConfiguration";
import { useHttpConfig } from "~/core/config/httpConfig";

export default function ConfigurationRoute() {
  const {
    config,
    updatePricingConfig,
    updateSupplyAnalysisConfig,
    updateFileConfig,
    updateFormDefaults,
    resetToDefaults,
  } = useConfiguration();
  const httpConfig = useHttpConfig();
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  const [successMessage, setSuccessMessage] = React.useState<string>("");

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
        Customize default values and pricing parameters. Changes are
        automatically saved to local storage.
      </Typography>

      {!httpConfig.config.tcgAuthCookie && (
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
                  "enableSupplyAnalysis"
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

              <TextField
                label="Max Listings Per SKU"
                type="number"
                value={config.supplyAnalysis.maxListingsPerSku}
                onChange={handleSupplyAnalysisConfigChange("maxListingsPerSku")}
                inputProps={{ min: 50, max: 500, step: 50 }}
                helperText="Maximum number of listings to fetch per SKU (higher = more accurate but slower)"
              />

              <FormControlLabel
                control={
                  <Switch
                    checked={config.supplyAnalysis.includeUnverifiedSellers}
                    onChange={handleSupplyAnalysisConfigChange(
                      "includeUnverifiedSellers"
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
