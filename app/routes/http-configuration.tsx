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
} from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";
import { useHttpConfig } from "~/core/config/httpConfig";

export default function HttpConfigurationRoute() {
  const { config, updateConfig, resetToDefaults } = useHttpConfig();
  const [showCookie, setShowCookie] = React.useState(false);
  const [successMessage, setSuccessMessage] = React.useState<string>("");
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);

  const handleConfigChange =
    (field: keyof typeof config) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        event.target.type === "number"
          ? Number(event.target.value)
          : event.target.value;
      updateConfig({ [field]: value });
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
        HTTP Configuration
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Configure HTTP client settings for TCGPlayer API requests. Changes are
        automatically saved to local storage.
      </Typography>

      {successMessage && (
        <Alert severity="success" sx={{ mb: 3 }}>
          {successMessage}
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
          <TextField
            label="Request Delay (ms)"
            type="number"
            value={config.requestDelayMs}
            onChange={handleConfigChange("requestDelayMs")}
            inputProps={{ min: 0, step: 100 }}
            helperText="Delay between consecutive requests to avoid rate limiting"
          />
          <TextField
            label="Rate Limit Cooldown (ms)"
            type="number"
            value={config.rateLimitCooldownMs}
            onChange={handleConfigChange("rateLimitCooldownMs")}
            inputProps={{ min: 0, step: 1000 }}
            helperText="Cooldown period after receiving a 403 rate limit response"
          />
          <TextField
            label="Max Concurrent Requests"
            type="number"
            value={config.maxConcurrentRequests}
            onChange={handleConfigChange("maxConcurrentRequests")}
            inputProps={{ min: 1, max: 10 }}
            helperText="Maximum number of simultaneous HTTP requests"
          />
        </Stack>
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
