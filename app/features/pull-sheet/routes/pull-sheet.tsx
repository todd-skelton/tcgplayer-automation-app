import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  Box,
  Typography,
  Paper,
  Button,
  Alert,
  ToggleButtonGroup,
  ToggleButton,
  Chip,
  LinearProgress,
  TextField,
} from "@mui/material";
import ViewListIcon from "@mui/icons-material/ViewList";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { PullSheetTable } from "../components/PullSheetTable";
import { PullSheetGrid } from "../components/PullSheetGrid";
import { loadPullSheetItemsFromCsvText } from "../utils/pullSheetItems";
import { useSearchParams } from "react-router";
import type { PullSheetItem } from "../types/pullSheetTypes";

type ViewMode = "table" | "grid";
const PULL_SHEET_IMPORT_STORAGE_PREFIX = "pull-sheet-import:";

export default function PullSheetRoute() {
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState<PullSheetItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [orderIds, setOrderIds] = useState<string[]>([]);

  const loadPullSheetCsv = useCallback(
    async (text: string, nextFileName: string) => {
      setLoading(true);
      setError(null);
      setFileName(nextFileName);

      try {
        const result = await loadPullSheetItemsFromCsvText(text);
        setOrderIds(result.orderIds);
        setItems(result.items);
      } catch (err) {
        setError(`Failed to process file: ${String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const text = await file.text();
      await loadPullSheetCsv(text, file.name);
    },
    [loadPullSheetCsv],
  );

  useEffect(() => {
    const importKey = searchParams.get("importKey");

    if (!importKey || typeof window === "undefined") {
      return;
    }

    const storageKey = `${PULL_SHEET_IMPORT_STORAGE_PREFIX}${importKey}`;
    const storedValue = window.localStorage.getItem(storageKey);

    if (!storedValue) {
      setError("The shared pull sheet data was not found. Generate it again from Shipping Export.");
      return;
    }

    window.localStorage.removeItem(storageKey);

    try {
      const payload = JSON.parse(storedValue) as {
        csvText?: string;
        fileName?: string;
      };

      if (!payload.csvText) {
        setError("The shared pull sheet data was empty. Generate it again from Shipping Export.");
        return;
      }

      void loadPullSheetCsv(
        payload.csvText,
        payload.fileName || "shipping-export-pull-sheet.csv",
      );
      window.history.replaceState({}, "", "/pull-sheet");
    } catch (error) {
      setError(`Failed to load shared pull sheet data: ${String(error)}`);
    }
  }, [loadPullSheetCsv, searchParams]);

  const handleViewModeChange = useCallback(
    (_: React.MouseEvent<HTMLElement>, newMode: ViewMode | null) => {
      if (newMode) setViewMode(newMode);
    },
    []
  );

  const filteredItems = useMemo(() => {
    if (!filterText.trim()) return items;
    const lower = filterText.toLowerCase();
    return items.filter(
      (item) =>
        item.productName.toLowerCase().includes(lower) ||
        item.set.toLowerCase().includes(lower) ||
        item.number.toLowerCase().includes(lower) ||
        item.productLine.toLowerCase().includes(lower)
    );
  }, [items, filterText]);

  const stats = useMemo(() => {
    const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);
    const notFound = items.filter((item) => !item.found).length;
    return { totalQty, notFound };
  }, [items]);

  return (
    <Box sx={{ maxWidth: 1400, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Pull Sheet
      </Typography>

      {/* Upload section */}
      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            flexWrap: "wrap",
          }}
        >
          <Button
            variant="contained"
            component="label"
            startIcon={<UploadFileIcon />}
            disabled={loading}
          >
            Upload Pull Sheet CSV
            <input
              type="file"
              hidden
              accept=".csv"
              onChange={handleFileUpload}
              onClick={(e) => {
                // Allow re-uploading the same file
                (e.target as HTMLInputElement).value = "";
              }}
            />
          </Button>

          {fileName && (
            <Typography variant="body2" color="text.secondary">
              {fileName}
            </Typography>
          )}

          {items.length > 0 && (
            <>
              <Box sx={{ flexGrow: 1 }} />
              <TextField
                size="small"
                placeholder="Filter items..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                sx={{ width: 250 }}
              />
              <ToggleButtonGroup
                value={viewMode}
                exclusive
                onChange={handleViewModeChange}
                size="small"
              >
                <ToggleButton value="table">
                  <ViewListIcon sx={{ mr: 0.5 }} /> Table
                </ToggleButton>
                <ToggleButton value="grid">
                  <ViewModuleIcon sx={{ mr: 0.5 }} /> Grid
                </ToggleButton>
              </ToggleButtonGroup>
            </>
          )}
        </Box>

        {loading && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress />
            <Typography variant="body2" sx={{ mt: 1 }}>
              Looking up SKUs in database...
            </Typography>
          </Box>
        )}
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Summary bar */}
      {items.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }} elevation={1}>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              flexWrap: "wrap",
            }}
          >
            <Chip label={`${items.length} items`} variant="filled" />
            <Chip label={`${stats.totalQty} total qty`} variant="outlined" />
            {stats.notFound > 0 && (
              <Chip
                label={`${stats.notFound} not in database`}
                color="warning"
                variant="outlined"
              />
            )}
            {orderIds.length > 0 && (
              <Chip
                label={`${orderIds.length} orders`}
                color="info"
                variant="outlined"
              />
            )}
            {filterText && (
              <Chip
                label={`Showing ${filteredItems.length} of ${items.length}`}
                color="primary"
                variant="outlined"
                size="small"
                onDelete={() => setFilterText("")}
              />
            )}
          </Box>
        </Paper>
      )}

      {/* Content views */}
      {items.length > 0 && viewMode === "table" && (
        <PullSheetTable items={filteredItems} />
      )}

      {items.length > 0 && viewMode === "grid" && (
        <PullSheetGrid items={filteredItems} />
      )}

      {/* Empty state */}
      {items.length === 0 && !loading && !error && (
        <Paper
          sx={{
            p: 6,
            textAlign: "center",
            backgroundColor: "action.hover",
          }}
          elevation={0}
        >
          <UploadFileIcon
            sx={{ fontSize: 64, color: "text.disabled", mb: 2 }}
          />
          <Typography variant="h6" color="text.secondary">
            Upload a TCGPlayer pull sheet CSV to get started
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
            The pull sheet will display all items with condition and print
            indicators to help you pull the correct cards.
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
            Shipping Export can also open this page in a new tab with a generated
            pull sheet ready to review.
          </Typography>
          <OpenInNewIcon sx={{ fontSize: 18, color: "text.disabled", mt: 2 }} />
        </Paper>
      )}
    </Box>
  );
}
