import React from "react";
import {
  Box,
  Typography,
  Paper,
  TextField,
  Stack,
  Alert,
  Button,
  IconButton,
  InputAdornment,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Divider,
  FormControlLabel,
  Switch,
  Chip,
} from "@mui/material";
import { Visibility, VisibilityOff, ExpandMore } from "@mui/icons-material";
// Import types and UI constants from shared module (client-safe)
import {
  type HttpConfig,
  type DomainRateLimitConfig,
  type DomainKey,
  type AdaptiveConfig,
  DOMAIN_KEYS,
  DEFAULT_HTTP_CONFIG,
  DOMAIN_DISPLAY_NAMES,
} from "~/core/config/httpConfig.shared";
import {
  data,
  useLoaderData,
  useFetcher,
  type LoaderFunctionArgs,
} from "react-router";
// Import server-only functions (will be tree-shaken from client bundle)
import { getHttpConfig, saveHttpConfig } from "~/core/config/httpConfig.server";

export async function loader() {
  const config = await getHttpConfig();
  return data({ config });
}

export async function action({ request }: LoaderFunctionArgs) {
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "update") {
    // Parse domain configs from form data
    const domainConfigs: Record<string, DomainRateLimitConfig> = {};
    for (const domainKey of Object.values(DOMAIN_KEYS)) {
      domainConfigs[domainKey] = {
        requestDelayMs:
          Number(formData.get(`${domainKey}_requestDelayMs`)) || 1500,
        rateLimitCooldownMs:
          Number(formData.get(`${domainKey}_rateLimitCooldownMs`)) || 60000,
        maxConcurrentRequests:
          Number(formData.get(`${domainKey}_maxConcurrentRequests`)) || 5,
        adaptiveEnabled:
          formData.get(`${domainKey}_adaptiveEnabled`) === "true",
        minRequestDelayMs:
          Number(formData.get(`${domainKey}_minRequestDelayMs`)) || 200,
        maxRequestDelayMs:
          Number(formData.get(`${domainKey}_maxRequestDelayMs`)) || 10000,
        learnedMinDelayMs:
          Number(formData.get(`${domainKey}_learnedMinDelayMs`)) || 200,
      };
    }

    const config: HttpConfig = {
      tcgAuthCookie: formData.get("tcgAuthCookie") as string,
      userAgent: formData.get("userAgent") as string,
      // Per-domain configs
      domainConfigs: domainConfigs as HttpConfig["domainConfigs"],
      // Global adaptive algorithm settings
      adaptiveConfig: {
        increaseMultiplier:
          Number(formData.get("adaptive_increaseMultiplier")) || 2.0,
        floorStepMs: Number(formData.get("adaptive_floorStepMs")) || 100,
        decreaseAmountMs:
          Number(formData.get("adaptive_decreaseAmountMs")) || 100,
        successThreshold:
          Number(formData.get("adaptive_successThreshold")) || 10,
      },
    };

    await saveHttpConfig(config);
    return data({ success: true, message: "Configuration saved" });
  }

  if (actionType === "reset") {
    await saveHttpConfig(DEFAULT_HTTP_CONFIG);
    return data({ success: true, message: "Configuration reset to defaults" });
  }

  return data({ success: false, message: "Unknown action" }, { status: 400 });
}

export default function HttpConfigurationRoute() {
  const { config: initialConfig } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [config, setConfig] = React.useState(initialConfig);
  const [showCookie, setShowCookie] = React.useState(false);
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);

  // Update local state when fetcher completes
  React.useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // Reload to get fresh data
      window.location.reload();
    }
  }, [fetcher.state, fetcher.data]);

  const handleConfigChange =
    (field: keyof HttpConfig) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        event.target.type === "number"
          ? Number(event.target.value)
          : event.target.value;
      setConfig((prev) => ({ ...prev, [field]: value }));
    };

  const handleDomainConfigChange =
    (domainKey: DomainKey, field: keyof DomainRateLimitConfig) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        event.target.type === "checkbox"
          ? event.target.checked
          : Number(event.target.value);
      setConfig((prev) => ({
        ...prev,
        domainConfigs: {
          ...prev.domainConfigs,
          [domainKey]: {
            ...prev.domainConfigs[domainKey],
            [field]: value,
          },
        },
      }));
    };

  const handleAdaptiveConfigChange =
    (field: keyof AdaptiveConfig) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      setConfig((prev) => ({
        ...prev,
        adaptiveConfig: {
          ...prev.adaptiveConfig,
          [field]: value,
        },
      }));
    };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("actionType", "update");
    formData.append("tcgAuthCookie", config.tcgAuthCookie);
    formData.append("userAgent", config.userAgent);

    // Add per-domain configs
    for (const domainKey of Object.values(DOMAIN_KEYS)) {
      const domainConfig = config.domainConfigs[domainKey];
      formData.append(
        `${domainKey}_requestDelayMs`,
        domainConfig.requestDelayMs.toString(),
      );
      formData.append(
        `${domainKey}_rateLimitCooldownMs`,
        domainConfig.rateLimitCooldownMs.toString(),
      );
      formData.append(
        `${domainKey}_maxConcurrentRequests`,
        domainConfig.maxConcurrentRequests.toString(),
      );
      formData.append(
        `${domainKey}_adaptiveEnabled`,
        domainConfig.adaptiveEnabled.toString(),
      );
      formData.append(
        `${domainKey}_minRequestDelayMs`,
        domainConfig.minRequestDelayMs.toString(),
      );
      formData.append(
        `${domainKey}_maxRequestDelayMs`,
        domainConfig.maxRequestDelayMs.toString(),
      );
      formData.append(
        `${domainKey}_learnedMinDelayMs`,
        domainConfig.learnedMinDelayMs.toString(),
      );
    }

    // Add global adaptive config
    formData.append(
      "adaptive_increaseMultiplier",
      config.adaptiveConfig.increaseMultiplier.toString(),
    );
    formData.append(
      "adaptive_floorStepMs",
      config.adaptiveConfig.floorStepMs.toString(),
    );
    formData.append(
      "adaptive_decreaseAmountMs",
      config.adaptiveConfig.decreaseAmountMs.toString(),
    );
    formData.append(
      "adaptive_successThreshold",
      config.adaptiveConfig.successThreshold.toString(),
    );

    fetcher.submit(formData, { method: "post" });
  };

  const handleReset = () => {
    if (showResetConfirm) {
      const formData = new FormData();
      formData.append("actionType", "reset");
      fetcher.submit(formData, { method: "post" });
      setShowResetConfirm(false);
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 5000);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        HTTP Configuration
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Configure HTTP client settings for TCGPlayer API requests. Changes are
        saved to the database.
      </Typography>

      {fetcher.data?.success && (
        <Alert severity="success" sx={{ mb: 3 }}>
          {fetcher.data.message}
        </Alert>
      )}

      {fetcher.data && !fetcher.data.success && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {fetcher.data.message}
        </Alert>
      )}

      {/* Authentication */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Authentication
        </Typography>
        <Stack spacing={3}>
          <TextField
            label="TCGPlayer Auth Cookie"
            type={showCookie ? "text" : "password"}
            value={config.tcgAuthCookie}
            onChange={handleConfigChange("tcgAuthCookie")}
            helperText="Your TCGAuthTicket_Production cookie value (without the key name)"
            fullWidth
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowCookie(!showCookie)}
                    edge="end"
                  >
                    {showCookie ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
          <Alert severity="info">
            To get your auth cookie:
            <ol style={{ marginBottom: 0, paddingLeft: 20 }}>
              <li>Log in to TCGPlayer.com</li>
              <li>Open browser DevTools (F12)</li>
              <li>Go to Application/Storage → Cookies</li>
              <li>Copy the value of TCGAuthTicket_Production</li>
            </ol>
          </Alert>
        </Stack>
      </Paper>

      {/* Request Settings */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Request Settings
        </Typography>
        <Stack spacing={3}>
          <TextField
            label="User Agent"
            value={config.userAgent}
            onChange={handleConfigChange("userAgent")}
            helperText="Browser user agent string"
            fullWidth
          />
        </Stack>
      </Paper>

      {/* Adaptive Algorithm Settings */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Adaptive Algorithm Settings
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Configure the AIMD (Additive Increase, Multiplicative Decrease)
          algorithm used for adaptive rate limiting. These settings apply
          globally to all domains with adaptive mode enabled.
        </Typography>
        <Stack spacing={2}>
          <TextField
            label="Increase Multiplier"
            type="number"
            value={config.adaptiveConfig.increaseMultiplier}
            onChange={handleAdaptiveConfigChange("increaseMultiplier")}
            inputProps={{ min: 1.1, max: 5, step: 0.1 }}
            helperText="Multiply delay by this factor on rate limit (e.g., 2.0 = double)"
            size="small"
            fullWidth
          />
          <TextField
            label="Floor Step (ms)"
            type="number"
            value={config.adaptiveConfig.floorStepMs}
            onChange={handleAdaptiveConfigChange("floorStepMs")}
            inputProps={{ min: 10, step: 10 }}
            helperText="Amount to raise the learned floor on each rate limit"
            size="small"
            fullWidth
          />
          <TextField
            label="Decrease Amount (ms)"
            type="number"
            value={config.adaptiveConfig.decreaseAmountMs}
            onChange={handleAdaptiveConfigChange("decreaseAmountMs")}
            inputProps={{ min: 10, step: 10 }}
            helperText="Amount to decrease delay after a success streak"
            size="small"
            fullWidth
          />
          <TextField
            label="Success Threshold"
            type="number"
            value={config.adaptiveConfig.successThreshold}
            onChange={handleAdaptiveConfigChange("successThreshold")}
            inputProps={{ min: 1, step: 1 }}
            helperText="Number of consecutive successes before decreasing delay"
            size="small"
            fullWidth
          />
        </Stack>
      </Paper>

      {/* Domain Rate Limits */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Domain Rate Limits
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Configure rate limiting settings for each TCGPlayer API domain. Each
          domain has its own isolated rate limiter, so hitting a rate limit on
          one domain won't affect requests to other domains.
        </Typography>

        {Object.values(DOMAIN_KEYS).map((domainKey) => (
          <Accordion key={domainKey} defaultExpanded={false}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography fontWeight="medium">
                  {DOMAIN_DISPLAY_NAMES[domainKey]}
                </Typography>
                {config.domainConfigs[domainKey].adaptiveEnabled && (
                  <Chip label="Adaptive" size="small" color="primary" />
                )}
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={config.domainConfigs[domainKey].adaptiveEnabled}
                      onChange={handleDomainConfigChange(
                        domainKey,
                        "adaptiveEnabled",
                      )}
                    />
                  }
                  label="Enable Adaptive Rate Limiting"
                />
                {config.domainConfigs[domainKey].adaptiveEnabled && (
                  <Alert severity="info" sx={{ mb: 1 }}>
                    Adaptive mode uses AIMD algorithm: delay is multiplied by{" "}
                    {config.adaptiveConfig.increaseMultiplier}× on rate limit
                    (403/429), decreases by{" "}
                    {config.adaptiveConfig.decreaseAmountMs}
                    ms after {config.adaptiveConfig.successThreshold}{" "}
                    consecutive successes. The learned floor ratchets up by{" "}
                    {config.adaptiveConfig.floorStepMs}ms to prevent
                    oscillation.
                  </Alert>
                )}
                <TextField
                  label="Request Delay (ms)"
                  type="number"
                  value={config.domainConfigs[domainKey].requestDelayMs}
                  onChange={handleDomainConfigChange(
                    domainKey,
                    "requestDelayMs",
                  )}
                  inputProps={{ min: 0, step: 100 }}
                  helperText={
                    config.domainConfigs[domainKey].adaptiveEnabled
                      ? "Current delay (auto-adjusted when adaptive is enabled)"
                      : "Delay between consecutive requests"
                  }
                  size="small"
                  fullWidth
                />
                <TextField
                  label="Rate Limit Cooldown (ms)"
                  type="number"
                  value={config.domainConfigs[domainKey].rateLimitCooldownMs}
                  onChange={handleDomainConfigChange(
                    domainKey,
                    "rateLimitCooldownMs",
                  )}
                  inputProps={{ min: 0, step: 1000 }}
                  helperText="Cooldown after 403/429 response"
                  size="small"
                  fullWidth
                />
                <TextField
                  label="Max Concurrent Requests"
                  type="number"
                  value={config.domainConfigs[domainKey].maxConcurrentRequests}
                  onChange={handleDomainConfigChange(
                    domainKey,
                    "maxConcurrentRequests",
                  )}
                  inputProps={{ min: 1, max: 10 }}
                  helperText="Maximum simultaneous requests to this domain"
                  size="small"
                  fullWidth
                />
                {config.domainConfigs[domainKey].adaptiveEnabled && (
                  <>
                    <Divider />
                    <Typography variant="subtitle2" color="text.secondary">
                      Adaptive Bounds
                    </Typography>
                    <TextField
                      label="Min Request Delay (ms)"
                      type="number"
                      value={config.domainConfigs[domainKey].minRequestDelayMs}
                      onChange={handleDomainConfigChange(
                        domainKey,
                        "minRequestDelayMs",
                      )}
                      inputProps={{ min: 0, step: 50 }}
                      helperText="Absolute minimum delay (starting point for probing)"
                      size="small"
                      fullWidth
                    />
                    <TextField
                      label="Max Request Delay (ms)"
                      type="number"
                      value={config.domainConfigs[domainKey].maxRequestDelayMs}
                      onChange={handleDomainConfigChange(
                        domainKey,
                        "maxRequestDelayMs",
                      )}
                      inputProps={{ min: 1000, step: 1000 }}
                      helperText="Maximum delay cap"
                      size="small"
                      fullWidth
                    />
                    <TextField
                      label="Learned Min Delay (ms)"
                      type="number"
                      value={config.domainConfigs[domainKey].learnedMinDelayMs}
                      onChange={handleDomainConfigChange(
                        domainKey,
                        "learnedMinDelayMs",
                      )}
                      inputProps={{ min: 0, step: 100 }}
                      helperText="Runtime-learned floor (ratchets up on rate limits, reset by setting to Min Request Delay)"
                      size="small"
                      fullWidth
                    />
                  </>
                )}
              </Stack>
            </AccordionDetails>
          </Accordion>
        ))}

        <Box sx={{ mt: 3 }}>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={fetcher.state === "submitting"}
          >
            {fetcher.state === "submitting"
              ? "Saving..."
              : "Save Configuration"}
          </Button>
        </Box>
      </Paper>

      {/* Reset Configuration */}
      <Paper sx={{ p: 3 }} elevation={3}>
        <Typography variant="h6" gutterBottom>
          Reset Configuration
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Reset all HTTP configuration settings back to their original default
          values. This will clear your saved auth cookie.
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
          {showResetConfirm ? "Confirm Reset" : "Reset to Defaults"}
        </Button>
      </Paper>
    </Box>
  );
}
