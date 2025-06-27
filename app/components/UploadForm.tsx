import React from "react";
import { Box, Button, TextField } from "@mui/material";
import { PRICING_CONSTANTS, FILE_CONFIG } from "../constants/pricing";

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
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("csv") as File;
    const percentileValue = formData.get("percentile") as string;

    if (!file) {
      return;
    }

    const percentile =
      parseInt(percentileValue, 10) || PRICING_CONSTANTS.DEFAULT_PERCENTILE;
    onSubmit(file, percentile);
  };

  return (
    <form onSubmit={handleSubmit}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <TextField
          type="file"
          name="csv"
          required
          inputProps={{ accept: FILE_CONFIG.ACCEPT }}
          disabled={isProcessing}
        />
        <TextField
          label="Price Percentile"
          name="percentile"
          type="number"
          defaultValue={PRICING_CONSTANTS.DEFAULT_PERCENTILE}
          inputProps={{
            min: PRICING_CONSTANTS.MIN_PERCENTILE,
            max: PRICING_CONSTANTS.MAX_PERCENTILE,
          }}
          helperText={`Percentile for suggested price calculation (${PRICING_CONSTANTS.MIN_PERCENTILE}-${PRICING_CONSTANTS.MAX_PERCENTILE})`}
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
