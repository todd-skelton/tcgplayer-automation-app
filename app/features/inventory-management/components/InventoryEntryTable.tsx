import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  TextField,
  Button,
  Box,
  Typography,
  Chip,
  Alert,
  Select,
  MenuItem,
  FormControl,
  Dialog,
  DialogContent,
  IconButton,
  Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ImageIcon from "@mui/icons-material/Image";
import {
  type GridColDef,
  type GridRowsProp,
  GridToolbarContainer,
  GridToolbarQuickFilter,
} from "@mui/x-data-grid";
import { ClientOnlyDataGrid } from "../../file-upload/components/ClientOnlyDataGrid";
import type { Sku } from "../../../shared/data-types/sku";
import type { PendingInventoryEntry } from "../../pending-inventory/types/pendingInventory";
import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import { getConditionColor } from "../../../core/utils/conditionColors";
import { createDisplayName } from "../../../core/utils/displayNameUtils";
import { matchesNumberField } from "../../../core/utils/numberFieldMatching";

// Extended interface for SKUs with display information
interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
}

// Helper function to get quantity from pending inventory array
const getPendingQuantity = (
  pendingInventory: PendingInventoryEntry[],
  sku: number
): number => {
  const entry = pendingInventory.find((p) => p.sku === sku);
  return entry ? entry.quantity : 0;
};

// DataGrid row type
interface DataGridRow {
  id: string;
  productId: number;
  productName: string;
  displayName: string; // Enhanced name with card number for display
  variant: string;
  language: string;
  groupKey: string;
  skus: SkuWithDisplayInfo[];
  groupPendingTotal: number;
}

// Group SKUs by product/variant/language combination
type ProductGroup = {
  productId: number;
  productName: string;
  displayName: string; // Enhanced name with card number for display
  cardNumber?: string | null; // Card number for enhanced filtering
  variant: string;
  language: string;
  skus: SkuWithDisplayInfo[];
};

interface InventoryEntryTableProps {
  skus: SkuWithDisplayInfo[];
  pendingInventory: PendingInventoryEntry[];
  onUpdateQuantity: (
    sku: number,
    quantity: number,
    metadata: { productLineId: number; setId: number; productId: number }
  ) => void;
  sealedFilter?: "all" | "sealed" | "unsealed";
}

export const InventoryEntryTable: React.FC<InventoryEntryTableProps> =
  React.memo(
    ({ skus, pendingInventory, onUpdateQuantity, sealedFilter = "all" }) => {
      const [quantities, setQuantities] = useState<{ [sku: number]: string }>(
        {}
      );
      const [selectedSkus, setSelectedSkus] = useState<{
        [groupKey: string]: number;
      }>({});
      const [productNameFilter, setProductNameFilter] = useState<string>("");
      const [submittedProductNameFilter, setSubmittedProductNameFilter] =
        useState<string>("");
      const searchInputRef = useRef<HTMLInputElement>(null);
      const [isSearchFocused, setIsSearchFocused] = useState<boolean>(false);
      const firstPlusButtonRef = useRef<HTMLButtonElement>(null);
      const [imageDialogOpen, setImageDialogOpen] = useState<boolean>(false);
      const [selectedProductId, setSelectedProductId] = useState<number | null>(
        null
      );

      // Handle search submission
      const handleSearchSubmit = useCallback(() => {
        setSubmittedProductNameFilter(productNameFilter);
        // Focus the first + button after search is submitted
        setTimeout(() => {
          if (firstPlusButtonRef.current) {
            firstPlusButtonRef.current.focus();
          }
        }, 100);
      }, [productNameFilter]);

      // Handle Enter key press in search input
      const handleSearchKeyPress = useCallback(
        (event: React.KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleSearchSubmit();
          }
        },
        [handleSearchSubmit]
      );

      // Filter SKUs based on sealed filter
      const filteredSkus = useMemo(() => {
        let filtered = skus;

        // Apply sealed filter
        if (sealedFilter === "sealed") {
          filtered = filtered.filter((sku) => sku.sealed);
        } else if (sealedFilter === "unsealed") {
          filtered = filtered.filter((sku) => !sku.sealed);
        }

        return filtered;
      }, [skus, sealedFilter]);

      // Group SKUs by product/variant/language with memoization for better performance
      const groupedSkus = useMemo(() => {
        const groups: { [key: string]: ProductGroup } = {};

        filteredSkus.forEach((sku) => {
          const groupKey = `${sku.productId}-${sku.variant}-${sku.language}`;
          if (!groups[groupKey]) {
            const displayName = createDisplayName(
              sku.productName,
              sku.cardNumber,
              sku.rarityName,
              sku.variant,
              sku.language
            );
            groups[groupKey] = {
              productId: sku.productId,
              productName: sku.productName,
              displayName: displayName,
              cardNumber: sku.cardNumber,
              variant: sku.variant,
              language: sku.language,
              skus: [],
            };
          }
          groups[groupKey].skus.push(sku);
        });

        // Sort SKUs within each group by condition
        Object.values(groups).forEach((group) => {
          group.skus.sort((a, b) => {
            const conditionOrder: { [key in Condition]: number } = {
              "Near Mint": 1,
              "Lightly Played": 2,
              "Moderately Played": 3,
              "Heavily Played": 4,
              Damaged: 5,
            };
            return conditionOrder[a.condition] - conditionOrder[b.condition];
          });
        });

        // Sort groups alphabetically by display name (with card numbers), then by variant
        const sortedGroups = Object.values(groups).sort((a, b) => {
          // First sort by display name (includes card numbers)
          const displayNameComparison = a.displayName.localeCompare(
            b.displayName
          );
          if (displayNameComparison !== 0) {
            return displayNameComparison;
          }
          // If display names are the same, sort by variant
          return a.variant.localeCompare(b.variant);
        });

        // Apply product name filter
        if (submittedProductNameFilter.trim()) {
          const filterLower = submittedProductNameFilter.toLowerCase().trim();

          // Phase 1: Try enhanced number field matching first
          const numberMatches = sortedGroups.filter((group) =>
            matchesNumberField(submittedProductNameFilter, group.cardNumber)
          );

          // If we found matches using number field matching, return those only
          if (numberMatches.length > 0) {
            return numberMatches;
          }

          // Phase 2: Fallback to display name search if no number matches found
          return sortedGroups.filter((group) =>
            group.displayName.toLowerCase().includes(filterLower)
          );
        }

        return sortedGroups;
      }, [filteredSkus, submittedProductNameFilter]);

      // Create DataGrid rows from grouped SKUs - one row per product group
      const dataGridRows: GridRowsProp<DataGridRow> = useMemo(() => {
        return groupedSkus.map((group) => {
          const groupKey = `${group.productId}-${group.variant}-${group.language}`;
          const groupPendingTotal = group.skus.reduce(
            (sum, sku) => sum + getPendingQuantity(pendingInventory, sku.sku),
            0
          );

          return {
            id: groupKey,
            productId: group.productId,
            productName: group.productName,
            displayName: group.displayName,
            variant: group.variant,
            language: group.language,
            groupKey,
            skus: group.skus,
            groupPendingTotal,
          };
        });
      }, [groupedSkus, pendingInventory]);

      // Helper function to create SKU display name
      const createSkuDisplayName = useCallback(
        (sku: SkuWithDisplayInfo): string => {
          const parts: string[] = [sku.condition];
          if (sku.variant && sku.variant !== "Normal") {
            parts.push(sku.variant);
          }
          return parts.join(" ");
        },
        []
      );

      // Helper function to get metadata for a SKU
      const getSkuMetadata = useCallback(
        (sku: number) => {
          const skuData = skus.find((s) => s.sku === sku);
          if (!skuData) {
            throw new Error(`SKU ${sku} not found in available skus`);
          }
          return {
            productLineId: skuData.productLineId,
            setId: skuData.setId,
            productId: skuData.productId,
          };
        },
        [skus]
      );

      // Memoize callback functions to prevent unnecessary re-renders
      const handleQuantityChange = useCallback(
        (sku: number, value: string) => {
          setQuantities((prev) => ({ ...prev, [sku]: value }));

          const numValue = parseInt(value) || 0;

          try {
            const metadata = getSkuMetadata(sku);
            onUpdateQuantity(sku, numValue, metadata);
          } catch (error) {
            console.error("Failed to get SKU metadata:", error);
          }
        },
        [onUpdateQuantity, getSkuMetadata]
      );

      const handleQuickAdd = useCallback(
        (
          groupKey: string,
          amount: number,
          returnFocusToSearch: boolean = true
        ) => {
          const selectedSku = selectedSkus[groupKey];
          if (!selectedSku) return;

          const currentQty = getPendingQuantity(pendingInventory, selectedSku);
          const newQty = Math.max(0, currentQty + amount);
          setQuantities((prev) => ({
            ...prev,
            [selectedSku]: newQty.toString(),
          }));
          try {
            const metadata = getSkuMetadata(selectedSku);
            onUpdateQuantity(selectedSku, newQty, metadata);
          } catch (error) {
            console.error("Failed to get SKU metadata:", error);
          }

          // Only return focus to search input if explicitly requested (for mouse clicks)
          if (returnFocusToSearch) {
            setTimeout(() => {
              if (searchInputRef.current) {
                searchInputRef.current.focus();
                searchInputRef.current.select();
              }
            }, 0);
          }
        },
        [selectedSkus, pendingInventory, onUpdateQuantity, getSkuMetadata]
      );

      const handleSkuSelection = useCallback(
        (groupKey: string, skuId: number) => {
          setSelectedSkus((prev) => ({
            ...prev,
            [groupKey]: skuId,
          }));
        },
        []
      );

      // Handle keyboard shortcuts for plus button
      const handlePlusButtonKeyDown = useCallback(
        (
          event: React.KeyboardEvent,
          groupKey: string,
          availableSkus: SkuWithDisplayInfo[]
        ) => {
          const selectedSku = selectedSkus[groupKey];
          if (!selectedSku) return;

          // Handle spacebar and period to cycle through SKUs
          if (event.key === " " || event.key === ".") {
            event.preventDefault();
            event.stopPropagation();

            const currentIndex = availableSkus.findIndex(
              (sku) => sku.sku === selectedSku
            );

            // Cycle to next SKU, or wrap to first if at the end
            const nextIndex =
              currentIndex < availableSkus.length - 1 ? currentIndex + 1 : 0;
            const nextSku = availableSkus[nextIndex];

            if (nextSku) {
              handleSkuSelection(groupKey, nextSku.sku);
            }
          }
          // Handle + key to increment quantity
          else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            event.stopPropagation();

            const currentQty = getPendingQuantity(
              pendingInventory,
              selectedSku
            );
            const newQty = currentQty + 1;
            setQuantities((prev) => ({
              ...prev,
              [selectedSku]: newQty.toString(),
            }));
            try {
              const metadata = getSkuMetadata(selectedSku);
              onUpdateQuantity(selectedSku, newQty, metadata);
            } catch (error) {
              console.error("Failed to get SKU metadata:", error);
            }
          }
          // Handle Enter key to increment quantity and return focus to search
          else if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();

            const currentQty = getPendingQuantity(
              pendingInventory,
              selectedSku
            );
            const newQty = currentQty + 1;
            setQuantities((prev) => ({
              ...prev,
              [selectedSku]: newQty.toString(),
            }));
            try {
              const metadata = getSkuMetadata(selectedSku);
              onUpdateQuantity(selectedSku, newQty, metadata);
            } catch (error) {
              console.error("Failed to get SKU metadata:", error);
            }

            // Return focus to search input after Enter
            setTimeout(() => {
              if (searchInputRef.current) {
                searchInputRef.current.focus();
                searchInputRef.current.select();
              }
            }, 0);
          }
          // Handle - key to decrement quantity
          else if (event.key === "-" || event.key === "_") {
            event.preventDefault();
            event.stopPropagation();

            const currentQty = getPendingQuantity(
              pendingInventory,
              selectedSku
            );
            const newQty = Math.max(0, currentQty - 1);
            setQuantities((prev) => ({
              ...prev,
              [selectedSku]: newQty.toString(),
            }));
            try {
              const metadata = getSkuMetadata(selectedSku);
              onUpdateQuantity(selectedSku, newQty, metadata);
            } catch (error) {
              console.error("Failed to get SKU metadata:", error);
            }
          }
        },
        [
          selectedSkus,
          handleSkuSelection,
          pendingInventory,
          onUpdateQuantity,
          getSkuMetadata,
        ]
      );

      // Custom toolbar component for the Data Grid
      const CustomToolbar = () => {
        return (
          <GridToolbarContainer>
            <Box sx={{ width: 400 }}>
              <GridToolbarQuickFilter />
            </Box>
          </GridToolbarContainer>
        );
      };

      const getTotalPendingItems = useCallback(() => {
        return pendingInventory.reduce((sum, entry) => sum + entry.quantity, 0);
      }, [pendingInventory]);

      // Helper function to get TCGPlayer image URL
      const getTcgPlayerImageUrl = useCallback(
        (productId: number, size: string = "200x200") => {
          return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_${size}.jpg`;
        },
        []
      );

      // Handle thumbnail click to open full image
      const handleThumbnailClick = useCallback((productId: number) => {
        setSelectedProductId(productId);
        setImageDialogOpen(true);
      }, []);

      // Handle closing image dialog
      const handleCloseImageDialog = useCallback(() => {
        setImageDialogOpen(false);
        setSelectedProductId(null);
      }, []);

      // Define DataGrid columns
      const columns: GridColDef<DataGridRow>[] = [
        {
          field: "image",
          headerName: "Image",
          width: 60,
          sortable: false,
          filterable: false,
          renderCell: (params) => {
            return (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                }}
              >
                <Tooltip title="View product image">
                  <IconButton
                    size="small"
                    onClick={() => handleThumbnailClick(params.row.productId)}
                    sx={{
                      color: "primary.main",
                      "&:hover": {
                        color: "primary.dark",
                      },
                    }}
                  >
                    <ImageIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          },
        },
        {
          field: "skuSelector",
          headerName: "SKU Selection",
          width: 400,
          sortable: false,
          filterable: false,
          renderCell: (params) => {
            const selectedSku = selectedSkus[params.row.groupKey];
            return (
              <FormControl size="small" sx={{ minWidth: 380 }}>
                <Select
                  value={selectedSku || ""}
                  onChange={(e) =>
                    handleSkuSelection(
                      params.row.groupKey,
                      Number(e.target.value)
                    )
                  }
                  size="small"
                  displayEmpty
                >
                  <MenuItem value="" disabled>
                    Select SKU
                  </MenuItem>
                  {params.row.skus.map((sku) => (
                    <MenuItem key={sku.sku} value={sku.sku}>
                      {createSkuDisplayName(sku)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            );
          },
        },
        {
          field: "quantity",
          headerName: "Quantity",
          width: 160,
          renderCell: (params) => {
            const selectedSku = selectedSkus[params.row.groupKey];

            if (!selectedSku) {
              return (
                <Typography variant="body2" color="text.secondary">
                  Select SKU
                </Typography>
              );
            }

            const selectedSkuData = params.row.skus.find(
              (sku) => sku.sku === selectedSku
            );

            const currentQty = getPendingQuantity(
              pendingInventory,
              selectedSku
            );
            const displayValue =
              quantities[selectedSku] ?? currentQty.toString();

            // Check if this is the first row to add ref for auto-focus
            const isFirstRow =
              params.api.getRowIndexRelativeToVisibleRows(params.id) === 0;

            return (
              <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <Button
                  size="small"
                  onClick={() => handleQuickAdd(params.row.groupKey, -1)}
                  color="secondary"
                  variant="outlined"
                  disabled={!selectedSku || currentQty <= 0}
                  sx={{ minWidth: "32px", padding: "4px" }}
                  tabIndex={-1}
                >
                  -
                </Button>
                <TextField
                  size="small"
                  value={displayValue}
                  onChange={(e) =>
                    handleQuantityChange(selectedSku, e.target.value)
                  }
                  inputProps={{
                    min: 0,
                    style: { textAlign: "center" },
                  }}
                  sx={{ width: "48px" }}
                />
                <Button
                  size="small"
                  onClick={() => handleQuickAdd(params.row.groupKey, 1)}
                  onKeyDown={(e) =>
                    handlePlusButtonKeyDown(
                      e,
                      params.row.groupKey,
                      params.row.skus
                    )
                  }
                  color="primary"
                  variant="outlined"
                  disabled={!selectedSku}
                  sx={{ minWidth: "32px", padding: "4px" }}
                  ref={isFirstRow ? firstPlusButtonRef : undefined}
                >
                  +
                </Button>
              </Box>
            );
          },
        },
        {
          field: "displayName",
          headerName: "Product Name",
          flex: 1,
          minWidth: 300,
          filterable: true,
          renderCell: (params) => {
            const selectedSku = selectedSkus[params.row.groupKey];
            const selectedSkuData = selectedSku
              ? params.row.skus.find((sku) => sku.sku === selectedSku)
              : null;

            return (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  height: "100%",
                  flexWrap: "wrap",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: "medium",
                  }}
                >
                  {params.value}
                </Typography>
                {selectedSkuData && (
                  <Chip
                    label={createSkuDisplayName(selectedSkuData)}
                    color={getConditionColor(selectedSkuData.condition)}
                    size="small"
                    variant="outlined"
                    sx={{
                      fontStyle:
                        selectedSkuData.variant
                          ?.toLowerCase()
                          .includes("reverse") ||
                        selectedSkuData.variant?.toLowerCase().includes("holo")
                          ? "italic"
                          : "normal",
                      fontWeight:
                        selectedSkuData.variant
                          ?.toLowerCase()
                          .includes("1st") ||
                        selectedSkuData.variant?.toLowerCase().includes("first")
                          ? "bold"
                          : "normal",
                    }}
                  />
                )}
              </Box>
            );
          },
        },
      ];

      // Auto-select first SKU in each group if none selected
      useEffect(() => {
        const newSelectedSkus: { [groupKey: string]: number } = {};

        groupedSkus.forEach((group) => {
          const groupKey = `${group.productId}-${group.variant}-${group.language}`;
          if (!selectedSkus[groupKey] && group.skus.length > 0) {
            // Select the first SKU (which should be Near Mint due to sorting)
            newSelectedSkus[groupKey] = group.skus[0].sku;
          }
        });

        if (Object.keys(newSelectedSkus).length > 0) {
          setSelectedSkus((prev) => ({ ...prev, ...newSelectedSkus }));
        }
      }, [groupedSkus, selectedSkus]);

      // Show early return only if there are no SKUs at all (not just filtered out)
      if (skus.length === 0) {
        return (
          <Alert severity="info">
            No SKUs available. Please select a product line and set to see
            available inventory options.
          </Alert>
        );
      }

      return (
        <Box>
          {/* Product Name Search Filter */}
          <Box sx={{ mb: 2 }}>
            <TextField
              label={`Search Product Names (Press Enter to search)${
                productNameFilter &&
                productNameFilter !== submittedProductNameFilter
                  ? " - Press Enter!"
                  : ""
              }`}
              variant="outlined"
              size="small"
              value={productNameFilter}
              onChange={(e) => setProductNameFilter(e.target.value)}
              onKeyPress={handleSearchKeyPress}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => setIsSearchFocused(false)}
              placeholder="Type to filter products and press Enter..."
              sx={{
                width: 400,
                "& .MuiInputLabel-root": {
                  color:
                    productNameFilter &&
                    productNameFilter !== submittedProductNameFilter
                      ? "primary.main"
                      : undefined,
                },
              }}
              inputRef={searchInputRef}
              autoComplete="off"
              InputProps={{
                startAdornment: (
                  <Box sx={{ mr: 1, color: "text.secondary" }}>🔍</Box>
                ),
              }}
            />
            {productNameFilter && (
              <Button
                size="small"
                onClick={() => {
                  setProductNameFilter("");
                  setSubmittedProductNameFilter("");
                }}
                sx={{ ml: 1 }}
                variant="outlined"
              >
                Clear
              </Button>
            )}
            {productNameFilter &&
              productNameFilter !== submittedProductNameFilter && (
                <Button
                  size="small"
                  onClick={handleSearchSubmit}
                  sx={{ ml: 1 }}
                  variant="contained"
                  color="primary"
                >
                  Search
                </Button>
              )}
          </Box>

          <Box sx={{ mb: 2, display: "flex", gap: 1, alignItems: "center" }}>
            <Chip
              label={`${dataGridRows.length} products displayed`}
              color="info"
              variant="outlined"
            />
            {filteredSkus.length !== skus.length && (
              <Chip
                label={`${skus.length - filteredSkus.length} filtered out`}
                color="warning"
                variant="outlined"
                size="small"
              />
            )}
            {submittedProductNameFilter && (
              <Chip
                label={`Filtered by: "${submittedProductNameFilter}"`}
                color="primary"
                variant="outlined"
                size="small"
                onDelete={() => {
                  setProductNameFilter("");
                  setSubmittedProductNameFilter("");
                }}
              />
            )}
          </Box>

          <Box sx={{ height: 600, width: "100%" }}>
            <ClientOnlyDataGrid
              rows={dataGridRows}
              columns={columns}
              disableRowSelectionOnClick
              pagination
              pageSizeOptions={[25, 50, 100]}
              initialState={{
                pagination: {
                  paginationModel: {
                    pageSize: 100,
                  },
                },
                filter: {
                  filterModel: {
                    items: [],
                    quickFilterValues: [],
                  },
                },
              }}
              slots={{
                toolbar: CustomToolbar,
              }}
              sx={{
                "& .MuiDataGrid-row": {
                  "&:hover": {
                    backgroundColor: "action.hover",
                  },
                },
                "& .MuiDataGrid-cell": {
                  borderBottom: "1px solid",
                  borderColor: "divider",
                },
              }}
              getRowHeight={() => "auto"}
            />
          </Box>

          {/* Image Dialog for Full Size View */}
          <Dialog
            open={imageDialogOpen}
            onClose={handleCloseImageDialog}
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
                backgroundColor: "#f5f5f5",
              }}
            >
              <IconButton
                onClick={handleCloseImageDialog}
                sx={{
                  position: "absolute",
                  right: 8,
                  top: 8,
                  color: "grey.500",
                  backgroundColor: "white",
                  "&:hover": {
                    backgroundColor: "grey.100",
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
