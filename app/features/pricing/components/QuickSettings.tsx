import React from "react";
import { Chip, Box, Typography, Tooltip, IconButton } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import { Link } from "react-router";
import { usePricingConfig, useFormDefaults } from "../hooks/useConfiguration";

interface QuickSettingsProps {
  showTitle?: boolean;
  compact?: boolean;
}

export const QuickSettings: React.FC<QuickSettingsProps> = ({
  showTitle = true,
  compact = false,
}) => {
  const pricingConfig = usePricingConfig();
  const formDefaults = useFormDefaults();

  if (compact) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Chip
          size="small"
          label={`Default: ${formDefaults.config.percentile}%`}
          variant="outlined"
        />
        <Tooltip title="Configuration Settings">
          <IconButton
            component={Link}
            to="/configuration"
            size="small"
            sx={{ ml: 0.5 }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }

  return (
    <Box>
      {showTitle && (
        <Typography variant="subtitle2" gutterBottom>
          Current Settings
        </Typography>
      )}
      <Box
        sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}
      >
        <Chip
          size="small"
          label={`Default Percentile: ${formDefaults.config.percentile}%`}
          color="primary"
          variant="outlined"
        />
        <Chip
          size="small"
          label={`Range: ${pricingConfig.config.minPercentile}-${pricingConfig.config.maxPercentile}%`}
          variant="outlined"
        />
        {formDefaults.config.sellerKey && (
          <Chip
            size="small"
            label={`Seller: ${formDefaults.config.sellerKey}`}
            color="secondary"
            variant="outlined"
          />
        )}
        <Tooltip title="Manage Configuration Settings">
          <IconButton
            component={Link}
            to="/configuration"
            size="small"
            sx={{ ml: 0.5 }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
