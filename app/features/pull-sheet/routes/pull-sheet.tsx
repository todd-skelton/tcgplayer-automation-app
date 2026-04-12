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
import Papa from "papaparse";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { PullSheetTable } from "../components/PullSheetTable";
import { PullSheetGrid } from "../components/PullSheetGrid";
import { getReleaseYear } from "../components/pullSheetUtils";
import { mapPullSheetProductLineName } from "../utils/productLineNameMap";
import { useSearchParams } from "react-router";
import type {
  PullSheetCsvRow,
  PullSheetItem,
} from "../types/pullSheetTypes";
import type { Sku } from "~/shared/data-types/sku";

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
        const lines = text.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        let csvText = text;
        const extractedOrderIds: string[] = [];

        if (lastLine.startsWith("Orders Contained in Pull Sheet:")) {
          const ordersPart = lastLine.split(",").slice(1).join(",").trim();
          extractedOrderIds.push(
            ...ordersPart
              .split("|")
              .map((id) => id.trim())
              .filter(Boolean),
          );
          csvText = lines.slice(0, -1).join("\n");
        }
        setOrderIds(extractedOrderIds);

        const parseResult = Papa.parse<PullSheetCsvRow>(csvText, {
          header: true,
          skipEmptyLines: true,
        });

        if (parseResult.errors.length > 0) {
          const errorMessages = parseResult.errors
            .slice(0, 3)
            .map((e) => e.message)
            .join(", ");
          setError(`CSV parsing errors: ${errorMessages}`);
          return;
        }

        const rows = parseResult.data.filter(
          (row) => row.SkuId && row["Product Name"],
        );

        if (rows.length === 0) {
          setError(
            "No valid rows found in CSV. Expected columns: Product Line, Product Name, Condition, SkuId, etc.",
          );
          return;
        }

        const lookupItems = rows.map((row) => ({
          skuId: parseInt(row.SkuId, 10),
          productLineName: mapPullSheetProductLineName(row["Product Line"]),
        }));

        const response = await fetch("/api/pull-sheet-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: lookupItems }),
        });

        let skuMap: Record<number, Sku> = {};
        if (response.ok) {
          const result = await response.json();
          skuMap = result.skuMap || {};
        }

        const pullSheetItems: PullSheetItem[] = rows.map((row) => {
          const skuId = parseInt(row.SkuId, 10);
          const dbSku = skuMap[skuId];
          const productLine = mapPullSheetProductLineName(row["Product Line"]);

          return {
            skuId,
            productLine,
            productName: row["Product Name"],
            condition: row.Condition,
            number: row.Number,
            set: row.Set,
            releaseYear: getReleaseYear(row["Set Release Date"]),
            rarity: row.Rarity,
            quantity: parseInt(row.Quantity, 10) || 1,
            orderQuantity: row["Order Quantity"],
            productId: dbSku?.productId,
            productLineId: dbSku?.productLineId,
            variant: dbSku?.variant,
            dbCondition: dbSku?.condition,
            found: !!dbSku,
          };
        });

        setItems(pullSheetItems);
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
