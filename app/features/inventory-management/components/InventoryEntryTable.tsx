import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  TextField,
  Button,
  Box,
  Typography,
  Chip,
  Alert,
  Dialog,
  DialogContent,
  IconButton,
  Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ImageIcon from "@mui/icons-material/Image";
import {
  type GridColDef,
  type GridPaginationModel,
  type GridRowsProp,
  GridToolbarContainer,
  GridToolbarQuickFilter,
  useGridApiRef,
} from "@mui/x-data-grid";
import { ClientOnlyDataGrid } from "../../file-upload/components/ClientOnlyDataGrid";
import type { Sku } from "../../../shared/data-types/sku";
import type { PendingInventoryEntry } from "../../pending-inventory/types/pendingInventory";
import { getConditionColor } from "../../../core/utils/conditionColors";
import { createDisplayName } from "../../../core/utils/displayNameUtils";
import { matchesNumberField } from "../../../core/utils/numberFieldMatching";
import {
  getConditionSortRank,
  type InventorySelectableCondition,
} from "../../../core/utils/conditionOrder";

interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
  setNameId?: number;
  setReleaseDate?: string;
}

const getPendingQuantity = (
  pendingInventory: PendingInventoryEntry[],
  sku: number
): number => {
  const entry = pendingInventory.find((pending) => pending.sku === sku);
  return entry ? entry.quantity : 0;
};

const getReleaseYear = (releaseDate?: string): string | null => {
  if (!releaseDate) {
    return null;
  }

  const releaseYear = new Date(releaseDate).getFullYear();
  return Number.isNaN(releaseYear) ? null : releaseYear.toString();
};

interface DataGridRow {
  id: string;
  productId: number;
  productName: string;
  displayName: string;
  setName: string;
  setReleaseYear?: string | null;
  variant: string;
  language: string;
  skus: SkuWithDisplayInfo[];
}

type ProductGroup = {
  productId: number;
  productName: string;
  displayName: string;
  setName: string;
  setReleaseYear?: string | null;
  cardNumber?: string | null;
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
  searchScope: "set" | "allSets";
  allSetsSearchTerm: string;
  selectedCondition: InventorySelectableCondition;
  onAllSetsSearch: (cardNumber: string) => Promise<void>;
  sealedFilter?: "all" | "sealed" | "unsealed";
}

interface ImageGridCellProps {
  productId: number;
  onThumbnailClick: (productId: number) => void;
}

const ImageGridCell = React.memo(({ productId, onThumbnailClick }: ImageGridCellProps) => (
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
        onClick={() => onThumbnailClick(productId)}
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
));

interface SetGridCellProps {
  setName: string;
  setReleaseYear?: string | null;
  activeSku: SkuWithDisplayInfo | null;
}

const SetGridCell = React.memo(
  ({ setName, setReleaseYear, activeSku }: SetGridCellProps) => (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        height: "100%",
        width: "100%",
      }}
    >
      <Chip
        label={setReleaseYear ? `${setName} - ${setReleaseYear}` : setName}
        color={activeSku ? getConditionColor(activeSku.condition) : "default"}
        size="small"
        variant="outlined"
        sx={{
          maxWidth: "none",
          "& .MuiChip-label": {
            display: "block",
            whiteSpace: "nowrap",
          },
        }}
      />
    </Box>
  )
);

interface SkuGridCellProps {
  activeSku: SkuWithDisplayInfo | null;
  selectedCondition: InventorySelectableCondition;
  conditionLabel: string;
}

const SkuGridCell = React.memo(
  ({ activeSku, selectedCondition, conditionLabel }: SkuGridCellProps) => (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        height: "100%",
        width: "100%",
      }}
    >
      <Chip
        label={conditionLabel}
        color={activeSku ? getConditionColor(activeSku.condition) : "warning"}
        size="small"
        variant="outlined"
        sx={{
          maxWidth: "none",
          fontStyle:
            activeSku &&
            (activeSku.variant?.toLowerCase().includes("reverse") ||
              activeSku.variant?.toLowerCase().includes("holo"))
              ? "italic"
              : "normal",
          fontWeight:
            activeSku &&
            (activeSku.variant?.toLowerCase().includes("1st") ||
              activeSku.variant?.toLowerCase().includes("first"))
              ? "bold"
              : "normal",
          opacity: activeSku ? 1 : 0.75,
          "& .MuiChip-label": {
            display: "block",
            whiteSpace: "nowrap",
          },
        }}
      />
    </Box>
  ),
  (previousProps, nextProps) =>
    previousProps.activeSku === nextProps.activeSku &&
    previousProps.selectedCondition === nextProps.selectedCondition &&
    previousProps.conditionLabel === nextProps.conditionLabel
);

interface ProductNameGridCellProps {
  value: string;
  activeSku: SkuWithDisplayInfo | null;
}

const ProductNameGridCell = React.memo(
  ({ value, activeSku }: ProductNameGridCellProps) => (
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
          color: activeSku
            ? `${getConditionColor(activeSku.condition)}.main`
            : "text.primary",
        }}
      >
        {value}
      </Typography>
    </Box>
  )
);

interface QuantityGridCellProps {
  activeSku: SkuWithDisplayInfo | null;
  currentQty: number;
  isFirstRow: boolean;
  selectedCondition: InventorySelectableCondition;
  firstPlusButtonRef: React.RefObject<HTMLButtonElement | null>;
  onQuantityChange: (sku: number, value: string) => void;
  onQuickAdd: (
    activeSku: SkuWithDisplayInfo | null,
    amount: number,
    returnFocus?: boolean
  ) => void;
  onPlusButtonKeyDown: (
    event: React.KeyboardEvent,
    activeSku: SkuWithDisplayInfo | null
  ) => void;
}

const QuantityGridCell = React.memo(
  ({
    activeSku,
    currentQty,
    isFirstRow,
    selectedCondition,
    firstPlusButtonRef,
    onQuantityChange,
    onQuickAdd,
    onPlusButtonKeyDown,
  }: QuantityGridCellProps) => {
    const [displayValue, setDisplayValue] = useState(currentQty.toString());

    useEffect(() => {
      setDisplayValue(currentQty.toString());
    }, [activeSku?.sku, currentQty]);

    if (!activeSku) {
      return (
        <Typography variant="body2" color="text.secondary">
          {`${selectedCondition} unavailable`}
        </Typography>
      );
    }

    return (
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        <Button
          size="small"
          onClick={() => {
            const nextQty = Math.max(0, currentQty - 1);
            setDisplayValue(nextQty.toString());
            onQuickAdd(activeSku, -1);
          }}
          color="secondary"
          variant="outlined"
          disabled={currentQty <= 0}
          sx={{ minWidth: "32px", padding: "4px" }}
          tabIndex={-1}
        >
          -
        </Button>
        <TextField
          size="small"
          value={displayValue}
          onChange={(event) => {
            const nextValue = event.target.value;
            setDisplayValue(nextValue);
            onQuantityChange(activeSku.sku, nextValue);
          }}
          inputProps={{
            min: 0,
            style: { textAlign: "center" },
          }}
          sx={{ width: "56px" }}
        />
        <Button
          size="small"
          onClick={() => {
            const nextQty = currentQty + 1;
            setDisplayValue(nextQty.toString());
            onQuickAdd(activeSku, 1);
          }}
          onKeyDown={(event) => onPlusButtonKeyDown(event, activeSku)}
          color="primary"
          variant="outlined"
          sx={{ minWidth: "32px", padding: "4px" }}
          ref={isFirstRow ? firstPlusButtonRef : undefined}
        >
          +
        </Button>
      </Box>
    );
  },
  (previousProps, nextProps) =>
    previousProps.activeSku === nextProps.activeSku &&
    previousProps.currentQty === nextProps.currentQty &&
    previousProps.isFirstRow === nextProps.isFirstRow &&
    previousProps.selectedCondition === nextProps.selectedCondition &&
    previousProps.onQuantityChange === nextProps.onQuantityChange &&
    previousProps.onQuickAdd === nextProps.onQuickAdd &&
    previousProps.onPlusButtonKeyDown === nextProps.onPlusButtonKeyDown
);

export const InventoryEntryTable: React.FC<InventoryEntryTableProps> = React.memo(
  ({
    skus,
    pendingInventory,
    onUpdateQuantity,
    searchScope,
    allSetsSearchTerm,
    selectedCondition,
    onAllSetsSearch,
    sealedFilter = "all",
  }) => {
    const [productNameFilter, setProductNameFilter] = useState<string>("");
    const [submittedProductNameFilter, setSubmittedProductNameFilter] =
      useState<string>("");
    const apiRef = useGridApiRef();
    const searchInputRef = useRef<HTMLInputElement>(null);
    const firstPlusButtonRef = useRef<HTMLButtonElement>(null);
    const focusRetryTimeoutRef = useRef<number | null>(null);
    const [imageDialogOpen, setImageDialogOpen] = useState<boolean>(false);
    const [selectedProductId, setSelectedProductId] = useState<number | null>(
      null
    );
    const focusRequestCounterRef = useRef(0);
    const [pendingFocusRequestId, setPendingFocusRequestId] = useState<number | null>(
      null
    );
    const [completedFocusRequestId, setCompletedFocusRequestId] = useState<
      number | null
    >(null);
    const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({
      page: 0,
      pageSize: 100,
    });
    const autosizeFrameRef = useRef<number | null>(null);
    const pendingInventoryRef = useRef(pendingInventory);

    const clearFocusRetry = useCallback(() => {
      if (focusRetryTimeoutRef.current !== null) {
        window.clearTimeout(focusRetryTimeoutRef.current);
        focusRetryTimeoutRef.current = null;
      }
    }, []);

    const clearScheduledAutosize = useCallback(() => {
      if (autosizeFrameRef.current !== null) {
        window.cancelAnimationFrame(autosizeFrameRef.current);
        autosizeFrameRef.current = null;
      }
    }, []);

    useEffect(() => {
      pendingInventoryRef.current = pendingInventory;
    }, [pendingInventory]);

    const focusFirstQuantityPlusButton = useCallback(
      (remainingAttempts = 6) => {
        clearFocusRetry();

        const tryFocus = (attemptsLeft: number) => {
          if (firstPlusButtonRef.current) {
            firstPlusButtonRef.current.focus();
            focusRetryTimeoutRef.current = null;
            return;
          }

          if (attemptsLeft <= 1) {
            focusRetryTimeoutRef.current = null;
            return;
          }

          focusRetryTimeoutRef.current = window.setTimeout(() => {
            tryFocus(attemptsLeft - 1);
          }, 50);
        };

        focusRetryTimeoutRef.current = window.setTimeout(() => {
          tryFocus(remainingAttempts);
        }, 0);
      },
      [clearFocusRetry]
    );

    const handleSearchSubmit = useCallback(() => {
      const trimmedFilter = productNameFilter.trim();
      const shouldFocus =
        searchScope === "set" || trimmedFilter.length > 0;
      const nextFocusRequestId = shouldFocus
        ? focusRequestCounterRef.current + 1
        : null;

      if (nextFocusRequestId !== null) {
        focusRequestCounterRef.current = nextFocusRequestId;
        setPendingFocusRequestId(nextFocusRequestId);
        setCompletedFocusRequestId(null);
      } else {
        setPendingFocusRequestId(null);
        setCompletedFocusRequestId(null);
        clearFocusRetry();
      }

      setSubmittedProductNameFilter(trimmedFilter);

      if (searchScope === "allSets") {
        void onAllSetsSearch(trimmedFilter).then(() => {
          if (nextFocusRequestId !== null) {
            setCompletedFocusRequestId(nextFocusRequestId);
          }
        });
        return;
      }

      if (nextFocusRequestId !== null) {
        setCompletedFocusRequestId(nextFocusRequestId);
      }
    }, [
      clearFocusRetry,
      focusFirstQuantityPlusButton,
      onAllSetsSearch,
      productNameFilter,
      searchScope,
    ]);

    const handleSearchKeyPress = useCallback(
      (event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          handleSearchSubmit();
        }
      },
      [handleSearchSubmit]
    );

    const filteredSkus = useMemo(() => {
      let filtered = skus;

      if (sealedFilter === "sealed") {
        filtered = filtered.filter((sku) => sku.sealed);
      } else if (sealedFilter === "unsealed") {
        filtered = filtered.filter((sku) => !sku.sealed);
      }

      return filtered;
    }, [skus, sealedFilter]);

    const groupedSkus = useMemo(() => {
      const groups: { [key: string]: ProductGroup } = {};

      filteredSkus.forEach((sku) => {
        const groupKey = `${sku.productId}-${sku.variant}-${sku.language}`;

        if (!groups[groupKey]) {
          groups[groupKey] = {
            productId: sku.productId,
            productName: sku.productName,
            displayName: createDisplayName(
              sku.productName,
              sku.cardNumber,
              sku.rarityName,
              sku.variant,
              sku.language
            ),
            setName: sku.setName,
            setReleaseYear: getReleaseYear(sku.setReleaseDate),
            cardNumber: sku.cardNumber,
            variant: sku.variant,
            language: sku.language,
            skus: [],
          };
        }

        groups[groupKey].skus.push(sku);
      });

      Object.values(groups).forEach((group) => {
        group.skus.sort(
          (a, b) => getConditionSortRank(a.condition) - getConditionSortRank(b.condition)
        );
      });

      const sortedGroups = Object.values(groups).sort((a, b) => {
        const displayNameComparison = a.displayName.localeCompare(b.displayName);
        if (displayNameComparison !== 0) {
          return displayNameComparison;
        }

        return a.variant.localeCompare(b.variant);
      });

      if (searchScope === "set" && submittedProductNameFilter.trim()) {
        const filterLower = submittedProductNameFilter.toLowerCase().trim();

        const numberMatches = sortedGroups.filter((group) =>
          matchesNumberField(submittedProductNameFilter, group.cardNumber)
        );

        if (numberMatches.length > 0) {
          return numberMatches;
        }

        return sortedGroups.filter((group) =>
          group.displayName.toLowerCase().includes(filterLower)
        );
      }

      return sortedGroups;
    }, [filteredSkus, searchScope, submittedProductNameFilter]);

    const dataGridRows: GridRowsProp<DataGridRow> = useMemo(() => {
      return groupedSkus.map((group) => {
        return {
          id: `${group.productId}-${group.variant}-${group.language}`,
          productId: group.productId,
          productName: group.productName,
          displayName: group.displayName,
          setName: group.setName,
          setReleaseYear: group.setReleaseYear,
          variant: group.variant,
          language: group.language,
          skus: group.skus,
        };
      });
    }, [groupedSkus]);

    useEffect(() => {
      setPendingFocusRequestId(null);
      setCompletedFocusRequestId(null);
      clearFocusRetry();
      setProductNameFilter("");
      setSubmittedProductNameFilter("");
    }, [clearFocusRetry, searchScope]);

    useEffect(() => {
      if (
        pendingFocusRequestId === null ||
        completedFocusRequestId !== pendingFocusRequestId
      ) {
        return;
      }

      if (paginationModel.page !== 0) {
        return;
      }

      if (dataGridRows.length === 0) {
        setPendingFocusRequestId(null);
        setCompletedFocusRequestId(null);
        return;
      }

      focusFirstQuantityPlusButton();
      setPendingFocusRequestId(null);
      setCompletedFocusRequestId(null);
    }, [
      completedFocusRequestId,
      dataGridRows.length,
      focusFirstQuantityPlusButton,
      paginationModel.page,
      pendingFocusRequestId,
    ]);

    useEffect(() => {
      return () => {
        clearFocusRetry();
        clearScheduledAutosize();
      };
    }, [clearFocusRetry, clearScheduledAutosize]);

    const createSkuDisplayName = useCallback((sku: SkuWithDisplayInfo): string => {
      const parts: string[] = [sku.condition];
      if (sku.variant && sku.variant !== "Normal") {
        parts.push(sku.variant);
      }
      return parts.join(" ");
    }, []);

    const getActiveSku = useCallback(
      (availableSkus: SkuWithDisplayInfo[]): SkuWithDisplayInfo | null => {
        if (availableSkus.length === 0) {
          return null;
        }

        if (availableSkus[0]?.sealed) {
          return availableSkus.find((sku) => sku.condition === "Unopened") ?? null;
        }

        return (
          availableSkus.find((sku) => sku.condition === selectedCondition) ?? null
        );
      },
      [selectedCondition]
    );

    const skuMetadataBySku = useMemo(
      () =>
        new Map(
          skus.map((sku) => [
            sku.sku,
            {
              productLineId: sku.productLineId,
              setId: sku.setId,
              productId: sku.productId,
            },
          ])
        ),
      [skus]
    );

    const getSkuMetadata = useCallback(
      (sku: number) => {
        const metadata = skuMetadataBySku.get(sku);
        if (!metadata) {
          throw new Error(`SKU ${sku} not found in available skus`);
        }

        return metadata;
      },
      [skuMetadataBySku]
    );

    const getCurrentPendingQuantity = useCallback((sku: number) => {
      return getPendingQuantity(pendingInventoryRef.current, sku);
    }, []);

    const handleQuantityChange = useCallback(
      (sku: number, value: string) => {
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
      (activeSku: SkuWithDisplayInfo | null, amount: number, returnFocus = true) => {
        if (!activeSku) {
          return;
        }

        const currentQty = getCurrentPendingQuantity(activeSku.sku);
        const newQty = Math.max(0, currentQty + amount);

        try {
          const metadata = getSkuMetadata(activeSku.sku);
          onUpdateQuantity(activeSku.sku, newQty, metadata);
        } catch (error) {
          console.error("Failed to get SKU metadata:", error);
        }

        if (returnFocus) {
          setTimeout(() => {
            if (searchInputRef.current) {
              searchInputRef.current.focus();
              searchInputRef.current.select();
            }
          }, 0);
        }
      },
      [getCurrentPendingQuantity, onUpdateQuantity, getSkuMetadata]
    );

    const handlePlusButtonKeyDown = useCallback(
      (event: React.KeyboardEvent, activeSku: SkuWithDisplayInfo | null) => {
        if (!activeSku) {
          return;
        }

        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          event.stopPropagation();
          handleQuickAdd(activeSku, 1, false);
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          handleQuickAdd(activeSku, 1);
          return;
        }

        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          event.stopPropagation();
          handleQuickAdd(activeSku, -1, false);
        }
      },
      [handleQuickAdd]
    );

    const CustomToolbar = () => {
      return (
        <GridToolbarContainer>
          <Box sx={{ width: 400 }}>
            <GridToolbarQuickFilter />
          </Box>
        </GridToolbarContainer>
      );
    };

    const getTcgPlayerImageUrl = useCallback((productId: number, size = "200x200") => {
      return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_${size}.jpg`;
    }, []);

    const handleThumbnailClick = useCallback((productId: number) => {
      setSelectedProductId(productId);
      setImageDialogOpen(true);
    }, []);

    const handleCloseImageDialog = useCallback(() => {
      setImageDialogOpen(false);
      setSelectedProductId(null);
    }, []);

    const autosizeColumnFields = useMemo(
      () => (searchScope === "allSets" ? ["setName", "sku"] : ["sku"]),
      [searchScope]
    );

    const autosizeOptions = useMemo(
      () => ({
        includeHeaders: true,
        includeOutliers: true,
        expand: false,
      }),
      []
    );

    const scheduleAutosize = useCallback(() => {
      clearScheduledAutosize();

      autosizeFrameRef.current = window.requestAnimationFrame(() => {
        autosizeFrameRef.current = null;
        void apiRef.current?.autosizeColumns({
          ...autosizeOptions,
          columns: autosizeColumnFields,
        });
      });
    }, [apiRef, autosizeColumnFields, autosizeOptions, clearScheduledAutosize]);

    const columns: GridColDef<DataGridRow>[] = useMemo(() => {
      const baseColumns: GridColDef<DataGridRow>[] = [
        {
          field: "image",
          headerName: "Image",
          width: 60,
          sortable: false,
          filterable: false,
          renderCell: (params) => (
            <ImageGridCell
              productId={params.row.productId}
              onThumbnailClick={handleThumbnailClick}
            />
          ),
        },
      ];

      if (searchScope === "allSets") {
        baseColumns.push({
          field: "setName",
          headerName: "Set",
          minWidth: 170,
          sortable: false,
          filterable: false,
          renderCell: (params) => {
            const activeSku = getActiveSku(params.row.skus);
            return (
              <SetGridCell
                setName={params.row.setName}
                setReleaseYear={params.row.setReleaseYear}
                activeSku={activeSku}
              />
            );
          },
        });
      }

      baseColumns.push(
        {
          field: "sku",
          headerName: "SKU",
          minWidth: 165,
          sortable: false,
          filterable: false,
          renderCell: (params) => {
            const activeSku = getActiveSku(params.row.skus);
            const conditionLabel = activeSku
              ? createSkuDisplayName(activeSku)
              : `${selectedCondition} unavailable`;

            return (
              <SkuGridCell
                activeSku={activeSku}
                selectedCondition={selectedCondition}
                conditionLabel={conditionLabel}
              />
            );
          },
        },
        {
          field: "quantity",
          headerName: "Quantity",
          width: 150,
          renderCell: (params) => {
            const activeSku = getActiveSku(params.row.skus);
            const currentQty = activeSku
              ? getCurrentPendingQuantity(activeSku.sku)
              : 0;
            const isFirstRow =
              params.api.getRowIndexRelativeToVisibleRows(params.id) === 0;

            return (
              <QuantityGridCell
                activeSku={activeSku}
                currentQty={currentQty}
                isFirstRow={isFirstRow}
                selectedCondition={selectedCondition}
                firstPlusButtonRef={firstPlusButtonRef}
                onQuantityChange={handleQuantityChange}
                onQuickAdd={handleQuickAdd}
                onPlusButtonKeyDown={handlePlusButtonKeyDown}
              />
            );
          },
        },
        {
          field: "displayName",
          headerName: "Product Name",
          flex: 1,
          minWidth: 320,
          filterable: true,
          renderCell: (params) => {
            const activeSku = getActiveSku(params.row.skus);
            return (
              <ProductNameGridCell value={params.value} activeSku={activeSku} />
            );
          },
        }
      );

      return baseColumns;
    }, [
      createSkuDisplayName,
      getActiveSku,
      handlePlusButtonKeyDown,
      handleQuantityChange,
      handleQuickAdd,
      handleThumbnailClick,
      getCurrentPendingQuantity,
      searchScope,
      selectedCondition,
    ]);

    useEffect(() => {
      if (paginationModel.page === 0) {
        return;
      }

      setPaginationModel((current) => ({
        ...current,
        page: 0,
      }));
    }, [
      allSetsSearchTerm,
      groupedSkus,
      paginationModel.page,
      searchScope,
      submittedProductNameFilter,
    ]);

    useEffect(() => {
      scheduleAutosize();
    }, [
      allSetsSearchTerm,
      groupedSkus,
      paginationModel.page,
      paginationModel.pageSize,
      scheduleAutosize,
      searchScope,
      selectedCondition,
      submittedProductNameFilter,
    ]);

    const hasNoSkus = skus.length === 0;

    return (
      <Box>
        {(!hasNoSkus || searchScope === "allSets") && (
          <Box sx={{ mb: 2 }}>
            <TextField
              label={`${
                searchScope === "allSets"
                  ? "Search Card Number Across All Sets"
                  : "Search Product Names"
              } (Press Enter to search)${
                productNameFilter &&
                productNameFilter !== submittedProductNameFilter
                  ? " - Press Enter!"
                  : ""
              }`}
              variant="outlined"
              size="small"
              value={productNameFilter}
              onChange={(event) => setProductNameFilter(event.target.value)}
              onKeyPress={handleSearchKeyPress}
              placeholder={
                searchScope === "allSets"
                  ? "Type an exact card number like 3 or 3/120 and press Enter..."
                  : "Type to filter products and press Enter..."
              }
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
            />
            {productNameFilter && (
              <Button
                size="small"
                onClick={() => {
                  setProductNameFilter("");
                  setSubmittedProductNameFilter("");
                  if (searchScope === "allSets") {
                    onAllSetsSearch("");
                  }
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
                  {searchScope === "allSets" ? "Search All Sets" : "Search"}
                </Button>
              )}
          </Box>
        )}

        {hasNoSkus && (
          <Alert
            severity={
              searchScope === "allSets" && allSetsSearchTerm ? "warning" : "info"
            }
            sx={{ mb: 2 }}
          >
            {searchScope === "allSets"
              ? allSetsSearchTerm
                ? `No matches found for card number "${allSetsSearchTerm}" in the selected product line.`
                : "Enter a card number to search across all sets in the selected product line."
              : "No SKUs available. Please select a product line and set to see available inventory options."}
          </Alert>
        )}

        {!hasNoSkus && (
          <>
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
              {(searchScope === "allSets"
                ? allSetsSearchTerm
                : submittedProductNameFilter) && (
                <Chip
                  label={
                    searchScope === "allSets"
                      ? `Card number: "${allSetsSearchTerm}"`
                      : `Filtered by: "${submittedProductNameFilter}"`
                  }
                  color="primary"
                  variant="outlined"
                  size="small"
                  onDelete={() => {
                    setProductNameFilter("");
                    setSubmittedProductNameFilter("");
                    if (searchScope === "allSets") {
                      onAllSetsSearch("");
                    }
                  }}
                />
              )}
            </Box>

            <Box sx={{ height: 600, width: "100%" }}>
              <ClientOnlyDataGrid
                apiRef={apiRef}
                rows={dataGridRows}
                columns={columns}
                autosizeOnMount
                autosizeOptions={{
                  ...autosizeOptions,
                  columns: autosizeColumnFields,
                }}
                paginationModel={paginationModel}
                onPaginationModelChange={(model: GridPaginationModel) => {
                  setPaginationModel(model);
                  scheduleAutosize();
                }}
                disableRowSelectionOnClick
                pagination
                pageSizeOptions={[25, 50, 100]}
                initialState={{
                  pagination: {
                    paginationModel: {
                      pageSize: paginationModel.pageSize,
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
          </>
        )}

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
                onError={(event) => {
                  event.currentTarget.src = getTcgPlayerImageUrl(
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
