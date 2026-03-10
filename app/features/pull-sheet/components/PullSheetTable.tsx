import React, { useMemo, useState, useCallback } from "react";
import {
  Box,
  Chip,
  Typography,
  IconButton,
  Tooltip,
  Dialog,
  DialogContent,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ImageIcon from "@mui/icons-material/Image";
import type { GridColDef } from "@mui/x-data-grid";
import { ClientOnlyDataGrid } from "~/features/file-upload/components/ClientOnlyDataGrid";
import type { PullSheetItem } from "../types/pullSheetTypes";
import {
  getConditionChipColor,
  getVariantLabel,
  getTcgPlayerImageUrl,
} from "./pullSheetUtils";

interface PullSheetTableProps {
  items: PullSheetItem[];
}

export const PullSheetTable: React.FC<PullSheetTableProps> = React.memo(
  ({ items }) => {
    const theme = useTheme();
    const [imageDialogOpen, setImageDialogOpen] = useState(false);
    const [selectedProductId, setSelectedProductId] = useState<number | null>(
      null
    );

    const handleOpenImage = useCallback((productId: number) => {
      setSelectedProductId(productId);
      setImageDialogOpen(true);
    }, []);

    const handleCloseImage = useCallback(() => {
      setImageDialogOpen(false);
      setSelectedProductId(null);
    }, []);

    const rows = useMemo(
      () =>
        items.map((item, index) => ({
          id: `${item.skuId}-${index}`,
          ...item,
        })),
      [items]
    );

    const columns: GridColDef[] = useMemo(
      () => [
        {
          field: "image",
          headerName: "",
          width: 50,
          sortable: false,
          filterable: false,
          renderCell: (params) =>
            params.row.productId ? (
              <Tooltip title="View image">
                <IconButton
                  size="small"
                  onClick={() => handleOpenImage(params.row.productId)}
                  color="primary"
                >
                  <ImageIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : null,
        },
        {
          field: "productName",
          headerName: "Product",
          flex: 1,
          minWidth: 250,
          renderCell: (params) => (
            <Typography variant="body2">
              {params.value}
            </Typography>
          ),
        },
        {
          field: "number",
          headerName: "#",
          width: 100,
        },
        {
          field: "set",
          headerName: "Set",
          width: 200,
        },
        {
          field: "condition",
          headerName: "Condition",
          width: 180,
          renderCell: (params) => {
            const condition = params.row.dbCondition || params.row.condition;
            const variant = params.row.variant;
            return (
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", alignItems: "center" }}>
                <Chip
                  label={condition}
                  color={getConditionChipColor(condition)}
                  size="small"
                  variant="filled"
                />
                {variant && variant !== "Normal" && (
                  <Chip
                    label={getVariantLabel(variant)}
                    size="small"
                    variant="outlined"
                    sx={{
                      borderColor: variant.toLowerCase().includes("holo")
                        ? "#FFD700"
                        : undefined,
                      color: variant.toLowerCase().includes("holo")
                        ? "#B8860B"
                        : undefined,
                      fontStyle: variant.toLowerCase().includes("reverse")
                        ? "italic"
                        : "normal",
                      fontWeight: variant.toLowerCase().includes("1st")
                        ? "bold"
                        : "normal",
                    }}
                  />
                )}
              </Box>
            );
          },
        },
        {
          field: "rarity",
          headerName: "Rarity",
          width: 150,
        },
        {
          field: "quantity",
          headerName: "Qty",
          width: 60,
          type: "number",
        },
        {
          field: "productLine",
          headerName: "Product Line",
          width: 150,
        },
        {
          field: "orderQuantity",
          headerName: "Order",
          width: 200,
          renderCell: (params) => (
            <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
              {params.value}
            </Typography>
          ),
        },
      ],
      [handleOpenImage]
    );

    return (
      <Box>
        <Box sx={{ height: 700, width: "100%" }}>
          <ClientOnlyDataGrid
            rows={rows}
            columns={columns}
            disableRowSelectionOnClick
            pagination
            pageSizeOptions={[25, 50, 100]}
            initialState={{
              pagination: { paginationModel: { pageSize: 100 } },
            }}
            sx={{
              "& .MuiDataGrid-cell": {
                borderBottom: "1px solid",
                borderColor: "divider",
              },
            }}
            getRowHeight={() => "auto"}
          />
        </Box>

        <Dialog
          open={imageDialogOpen}
          onClose={handleCloseImage}
          maxWidth="md"
          fullWidth
        >
          <DialogContent
            sx={{
              position: "relative",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              p: 3,
              backgroundColor: "background.paper",
            }}
          >
            <IconButton
              onClick={handleCloseImage}
              sx={{
                position: "absolute",
                right: 8,
                top: 8,
                color: "text.secondary",
                backgroundColor:
                  theme.palette.mode === "dark"
                    ? "rgba(255,255,255,0.08)"
                    : "rgba(0,0,0,0.04)",
                "&:hover": {
                  backgroundColor:
                    theme.palette.mode === "dark"
                      ? "rgba(255,255,255,0.16)"
                      : "rgba(0,0,0,0.08)",
                },
              }}
            >
              <CloseIcon />
            </IconButton>
            {selectedProductId && (
              <img
                src={getTcgPlayerImageUrl(selectedProductId, "400x400")}
                alt="Product"
                style={{
                  maxWidth: "100%",
                  maxHeight: "70vh",
                  objectFit: "contain",
                }}
                onError={(e) => {
                  e.currentTarget.src = getTcgPlayerImageUrl(
                    selectedProductId,
                    "200x200"
                  );
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      </Box>
    );
  }
);
