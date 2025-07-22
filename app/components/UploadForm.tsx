import React from "react";
import { Box, Button, TextField } from "@mui/material";
import { useConfiguration } from "../hooks/useConfiguration";

interface UploadFormProps {
  onSubmit: (file: File, percentile: number) => void;
  isProcessing: boolean;
  onCancel: () => void;
}

export const UploadForm: React.FC<UploadFormProps> = ({
  onSubmit,
  isProcessing,
  onCancel,
}) => {
  const { config, updateFormDefaults } = useConfiguration();
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("csv") as File;
    const percentileValue = formData.get("percentile") as string;

    if (!file) {
      return;
    }

    const percentile =
      parseInt(percentileValue, 10) || config.pricing.defaultPercentile;

    // Save percentile as form default for next time
    updateFormDefaults({ percentile });

    onSubmit(file, percentile);
  };

  return (
    <form onSubmit={handleSubmit}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <TextField
          type="file"
          name="csv"
          required
          inputProps={{ accept: config.file.accept }}
          disabled={isProcessing}
        />
        <TextField
          label="Price Percentile"
          name="percentile"
          type="number"
          defaultValue={config.formDefaults.percentile}
          inputProps={{
            min: config.pricing.minPercentile,
            max: config.pricing.maxPercentile,
          }}
          helperText={`Percentile for suggested price calculation (${config.pricing.minPercentile}-${config.pricing.maxPercentile}). Examples: 65, 75, 80`}
          disabled={isProcessing}
        />
        <Box sx={{ display: "flex", gap: 2 }}>
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={isProcessing}
          >
            {isProcessing ? "Processing..." : "Upload and Price CSV"}
          </Button>

          {isProcessing && (
            <Button variant="outlined" color="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Box>
      </Box>
    </form>
  );
};
