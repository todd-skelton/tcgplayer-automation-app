import { useState } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { useConfiguration } from "~/features/pricing/hooks/useConfiguration";
import type { InventoryBatch } from "../types/inventoryBatch";

interface NewInventoryBatchFormProps {
  onCreated: (batch: InventoryBatch) => void | Promise<void>;
}

async function createBatch(input: RequestInit, url: string): Promise<InventoryBatch> {
  const response = await fetch(url, input);
  const payload = (await response.json()) as InventoryBatch | { error?: string };
  if (!response.ok) {
    throw new Error(
      "error" in payload && payload.error ? payload.error : "Failed to create batch",
    );
  }
  return payload as InventoryBatch;
}

export function NewInventoryBatchForm({ onCreated }: NewInventoryBatchFormProps) {
  const { config, updateFormDefaults } = useConfiguration();
  const [sellerKey, setSellerKey] = useState(config.formDefaults.sellerKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (create: () => Promise<InventoryBatch>) => {
    setBusy(true);
    setError(null);
    try {
      await onCreated(await create());
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  };

  const submitCsv = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("csv");
    if (!(file instanceof File) || file.size === 0) return;
    const body = new FormData();
    body.append("file", file);
    void run(() => createBatch({ method: "POST", body }, "/api/inventory-batches/import-csv"));
  };

  const submitSeller = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = sellerKey.trim();
    if (!key) return;
    updateFormDefaults({ sellerKey: key });
    void run(() =>
      createBatch(
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sellerKey: key }),
        },
        "/api/inventory-batches/import-seller",
      ),
    );
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">New Batch</Typography>
        <Typography variant="body2" color="text.secondary">
          Freeze a CSV export or a seller's live inventory into a batch. Pricing
          uses the server configuration.
        </Typography>
      </Box>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <Box component="form" onSubmit={submitCsv} sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              type="file"
              name="csv"
              size="small"
              required
              fullWidth
              inputProps={{ accept: config.file.accept, "aria-label": "CSV file" }}
              disabled={busy}
            />
            <Button type="submit" variant="contained" disabled={busy} sx={{ whiteSpace: "nowrap" }}>
              Upload CSV
            </Button>
          </Stack>
        </Box>
        <Box component="form" onSubmit={submitSeller} sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              label="Seller Key"
              size="small"
              value={sellerKey}
              onChange={(event) => setSellerKey(event.target.value)}
              required
              fullWidth
              disabled={busy}
            />
            <Button
              type="submit"
              variant="contained"
              disabled={busy || !sellerKey.trim()}
              sx={{ whiteSpace: "nowrap" }}
            >
              Snapshot Seller
            </Button>
          </Stack>
        </Box>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
