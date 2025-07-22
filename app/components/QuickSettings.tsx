import React from "react";
import { Chip, Box, Typography, Tooltip, IconButton } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import { Link } from "react-router";
import { useConfiguration } from "../hooks/useConfiguration";

interface QuickSettingsProps {
  showTitle?: boolean;
  compact?: boolean;
}

export const QuickSettings: React.FC<QuickSettingsProps> = ({
  showTitle = true,
  compact = false,
}) => {
  const { config } = useConfiguration();

  if (compact) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Chip
          size="small"
          label={`Default: ${config.formDefaults.percentile}%`}
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
          label={`Default Percentile: ${config.formDefaults.percentile}%`}
          color="primary"
          variant="outlined"
        />
        <Chip
          size="small"
          label={`Range: ${config.pricing.minPercentile}-${config.pricing.maxPercentile}%`}
          variant="outlined"
        />
        {config.formDefaults.sellerKey && (
          <Chip
            size="small"
            label={`Seller: ${config.formDefaults.sellerKey}`}
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
