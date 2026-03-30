import React from "react";
import { Box, Button, TextField, Typography } from "@mui/material";
import { useConfiguration } from "../../pricing/hooks/useConfiguration";

interface UploadFormProps {
  onSubmit: (file: File) => void | Promise<void>;
  isProcessing: boolean;
}

export const UploadForm: React.FC<UploadFormProps> = ({
  onSubmit,
  isProcessing,
}) => {
  const { config } = useConfiguration();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("csv") as File;

    if (!file || file.size === 0) {
      return;
    }

    onSubmit(file);
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
        <Typography variant="body2" color="text.secondary">
          Background pricing uses the shared server configuration, including the
          default percentile and any product-line overrides.
        </Typography>
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={isProcessing}
        >
          {isProcessing ? "Queueing Batch..." : "Upload and Queue Batch"}
        </Button>
      </Box>
    </form>
  );
};
