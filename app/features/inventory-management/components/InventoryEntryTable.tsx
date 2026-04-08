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
  Dialog,
  DialogContent,
  IconButton,
  Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ImageIcon from "@mui/icons-material/Image";
import {
  type GridColDef,
  type GridApi,
  type GridPaginationModel,
  type GridRowId,
  type GridRowsProp,
  GridToolbarContainer,
  GridToolbarQuickFilter,
  useGridApiRef,
} from "@mui/x-data-grid";
import { getVisibleRows } from "@mui/x-data-grid/internals";
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
import {
  getAdjacentVisibleQuantityRowId,
  getQuantityKeyboardAction,
  type QuantityNavigationDirection,
} from "./quantityKeyboard";

interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
  setNameId?: number;
  setReleaseDate?: string;
}

const getPendingQuantity = (
  pendingInventory: PendingInventoryEntry[],
  sku: number,
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

type AutosizedColumnField = "setName" | "sku";

interface InventoryEntryTableProps {
  skus: SkuWithDisplayInfo[];
  pendingInventory: PendingInventoryEntry[];
  onUpdateQuantity: (
    sku: number,
    quantity: number,
    metadata: { productLineId: number; setId: number; productId: number },
  ) => void;
  searchScope: "set" | "allSets";
  allSetsSearchTerm: string;
  selectedCondition: InventorySelectableCondition;
  onAllSetsSearch: (cardNumber: string) => Promise<void>;
  onChangeCondition: (direction: QuantityNavigationDirection) => void;
  sealedFilter?: "all" | "sealed" | "unsealed";
}

interface ImageGridCellProps {
  productId: number;
  onThumbnailClick: (productId: number) => void;
}

const ImageGridCell = React.memo(
  ({ productId, onThumbnailClick }: ImageGridCellProps) => (
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
  ),
);

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
  ),
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
    previousProps.conditionLabel === nextProps.conditionLabel,
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
  ),
);

interface QuantityGridCellProps {
  rowId: GridRowId;
  activeSku: SkuWithDisplayInfo | null;
  currentQty: number;
  selectedCondition: InventorySelectableCondition;
  onQuantityChange: (sku: number, value: string) => void;
  onQuickAdd: (
    activeSku: SkuWithDisplayInfo | null,
    amount: number,
    returnFocus?: boolean,
  ) => void;
  onFocusSearchInput: () => void;
  onFocusAdjacentQuantityInput: (
    rowId: GridRowId,
    direction: "previous" | "next",
  ) => void;
  onChangeCondition: (direction: QuantityNavigationDirection) => void;
  registerQuantityInput: (
    rowId: GridRowId,
    input: HTMLInputElement | null,
  ) => void;
}

const QuantityGridCell = React.memo(
  ({
    rowId,
    activeSku,
    currentQty,
    selectedCondition,
    onQuantityChange,
    onQuickAdd,
    onFocusSearchInput,
    onFocusAdjacentQuantityInput,
    onChangeCondition,
    registerQuantityInput,
  }: QuantityGridCellProps) => {
    const [displayValue, setDisplayValue] = useState(currentQty.toString());
    const quantityInputRef = useRef<HTMLInputElement | null>(null);
    const untouchedSinceFocusRef = useRef(true);
    const shouldReselectAfterSyncRef = useRef(false);

    const selectQuantityInput = useCallback(() => {
      const input = quantityInputRef.current;
      if (!input) {
        return;
      }

      window.setTimeout(() => {
        if (input.isConnected) {
          input.select();
        }
      }, 0);
    }, []);

    const handleQuantityInputRef = useCallback(
      (input: HTMLInputElement | null) => {
        quantityInputRef.current = input;
        registerQuantityInput(rowId, input);
      },
      [registerQuantityInput, rowId],
    );

    useEffect(() => {
      setDisplayValue(currentQty.toString());

      if (shouldReselectAfterSyncRef.current) {
        shouldReselectAfterSyncRef.current = false;
        selectQuantityInput();
      }
    }, [activeSku?.sku, currentQty, selectQuantityInput]);

    if (!activeSku) {
      return (
        <Typography variant="body2" color="text.secondary">
          {`${selectedCondition} unavailable`}
        </Typography>
      );
    }

    const applyKeyboardQuantityDelta = (amount: number) => {
      const nextQty = Math.max(0, currentQty + amount);
      untouchedSinceFocusRef.current = false;
      shouldReselectAfterSyncRef.current = true;
      setDisplayValue(nextQty.toString());
      onQuickAdd(activeSku, amount, false);
    };

    const handleQuantityKeyDown = (
      event: React.KeyboardEvent<HTMLInputElement>,
    ) => {
      if (!activeSku) {
        return;
      }

      const action = getQuantityKeyboardAction({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        untouchedSinceFocus: untouchedSinceFocusRef.current,
      });

      if (action.type === "none") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (action.type === "change-condition") {
        onChangeCondition(action.direction);
        return;
      }

      if (action.type === "move-focus") {
        onFocusAdjacentQuantityInput(rowId, action.direction);
        return;
      }

      if (action.type === "submit") {
        if (action.incrementQuantity) {
          untouchedSinceFocusRef.current = false;
          onQuickAdd(activeSku, 1, false);
        }

        onFocusSearchInput();
        return;
      }

      applyKeyboardQuantityDelta(action.amount);
    };

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
          inputRef={handleQuantityInputRef}
          onFocus={() => {
            untouchedSinceFocusRef.current = true;
            selectQuantityInput();
          }}
          onKeyDown={handleQuantityKeyDown}
          onChange={(event) => {
            const nextValue = event.target.value;
            untouchedSinceFocusRef.current = false;
            setDisplayValue(nextValue);
            onQuantityChange(activeSku.sku, nextValue);
          }}
          inputProps={{
            min: 0,
            "data-inventory-focus-id": `quantity:${rowId.toString()}`,
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
          color="primary"
          variant="outlined"
          sx={{ minWidth: "32px", padding: "4px" }}
        >
          +
        </Button>
      </Box>
    );
  },
  (previousProps, nextProps) =>
    previousProps.rowId === nextProps.rowId &&
    previousProps.activeSku === nextProps.activeSku &&
    previousProps.currentQty === nextProps.currentQty &&
    previousProps.selectedCondition === nextProps.selectedCondition &&
    previousProps.onQuantityChange === nextProps.onQuantityChange &&
    previousProps.onQuickAdd === nextProps.onQuickAdd &&
    previousProps.onFocusSearchInput === nextProps.onFocusSearchInput &&
    previousProps.onFocusAdjacentQuantityInput ===
      nextProps.onFocusAdjacentQuantityInput &&
    previousProps.onChangeCondition === nextProps.onChangeCondition &&
    previousProps.registerQuantityInput === nextProps.registerQuantityInput,
);

export const InventoryEntryTable: React.FC<InventoryEntryTableProps> =
  React.memo(
    ({
      skus,
      pendingInventory,
      onUpdateQuantity,
      searchScope,
      allSetsSearchTerm,
      selectedCondition,
      onAllSetsSearch,
      onChangeCondition,
      sealedFilter = "all",
    }) => {
      const [productNameFilter, setProductNameFilter] = useState<string>("");
      const [submittedProductNameFilter, setSubmittedProductNameFilter] =
        useState<string>("");
      const apiRef = useGridApiRef<GridApi>();
      const searchInputRef = useRef<HTMLInputElement>(null);
      const focusRetryTimeoutRef = useRef<number | null>(null);
      const quantityInputRefs = useRef<Map<GridRowId, HTMLInputElement>>(
        new Map(),
      );
      const [imageDialogOpen, setImageDialogOpen] = useState<boolean>(false);
      const [selectedProductId, setSelectedProductId] = useState<number | null>(
        null,
      );
      const focusRequestCounterRef = useRef(0);
      const [pendingFocusRequestId, setPendingFocusRequestId] = useState<
        number | null
      >(null);
      const [completedFocusRequestId, setCompletedFocusRequestId] = useState<
        number | null
      >(null);
      const [autosizedColumnWidths, setAutosizedColumnWidths] = useState<
        Partial<Record<AutosizedColumnField, number>>
      >({});
      const [paginationModel, setPaginationModel] =
        useState<GridPaginationModel>({
          page: 0,
          pageSize: 100,
        });
      const autosizeFrameRef = useRef<number | null>(null);
      const autosizeFollowUpFrameRef = useRef<number | null>(null);
      const autosizeInFlightRef = useRef(false);
      const autosizeQueuedRef = useRef(false);
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

        if (autosizeFollowUpFrameRef.current !== null) {
          window.cancelAnimationFrame(autosizeFollowUpFrameRef.current);
          autosizeFollowUpFrameRef.current = null;
        }
      }, []);

      useEffect(() => {
        pendingInventoryRef.current = pendingInventory;
      }, [pendingInventory]);

      const focusSearchInput = useCallback(() => {
        window.setTimeout(() => {
          if (searchInputRef.current) {
            searchInputRef.current.focus();
            searchInputRef.current.select();
          }
        }, 0);
      }, []);

      const registerQuantityInput = useCallback(
        (rowId: GridRowId, input: HTMLInputElement | null) => {
          if (input) {
            quantityInputRefs.current.set(rowId, input);
            return;
          }

          quantityInputRefs.current.delete(rowId);
        },
        [],
      );

      const handleSearchSubmit = useCallback(() => {
        const trimmedFilter = productNameFilter.trim();
        const shouldFocus = searchScope === "set" || trimmedFilter.length > 0;
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
      }, [clearFocusRetry, onAllSetsSearch, productNameFilter, searchScope]);

      const handleSearchKeyPress = useCallback(
        (event: React.KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleSearchSubmit();
          }
        },
        [handleSearchSubmit],
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
                sku.language,
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
            (a, b) =>
              getConditionSortRank(a.condition) -
              getConditionSortRank(b.condition),
          );
        });

        const sortedGroups = Object.values(groups).sort((a, b) => {
          const displayNameComparison = a.displayName.localeCompare(
            b.displayName,
          );
          if (displayNameComparison !== 0) {
            return displayNameComparison;
          }

          return a.variant.localeCompare(b.variant);
        });

        if (searchScope === "set" && submittedProductNameFilter.trim()) {
          const filterLower = submittedProductNameFilter.toLowerCase().trim();

          const numberMatches = sortedGroups.filter((group) =>
            matchesNumberField(submittedProductNameFilter, group.cardNumber),
          );

          if (numberMatches.length > 0) {
            return numberMatches;
          }

          return sortedGroups.filter((group) =>
            group.displayName.toLowerCase().includes(filterLower),
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

      const getVisibleQuantityRowIds = useCallback(() => {
        const gridApi = apiRef.current;
        if (!gridApi) {
          const pageStart = paginationModel.page * paginationModel.pageSize;
          const pageEnd = pageStart + paginationModel.pageSize;
          return dataGridRows.slice(pageStart, pageEnd).map((row) => row.id);
        }

        return getVisibleRows(apiRef as React.RefObject<GridApi>, {
          pagination: true,
          paginationMode: "client",
        }).rows.map((row) => row.id);
      }, [
        apiRef,
        dataGridRows,
        paginationModel.page,
        paginationModel.pageSize,
      ]);

      const focusQuantityInputByRowId = useCallback(
        (rowId: GridRowId | null | undefined) => {
          if (rowId === null || rowId === undefined) {
            return false;
          }

          const input = quantityInputRefs.current.get(rowId);
          if (!input || !input.isConnected) {
            return false;
          }

          input.focus();
          window.setTimeout(() => {
            if (input.isConnected) {
              input.select();
            }
          }, 0);
          return true;
        },
        [],
      );

      const focusFirstQuantityInput = useCallback(
        (remainingAttempts = 6) => {
          clearFocusRetry();

          const tryFocus = (attemptsLeft: number) => {
            const [firstRowId] = getVisibleQuantityRowIds();
            if (focusQuantityInputByRowId(firstRowId)) {
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
        [clearFocusRetry, focusQuantityInputByRowId, getVisibleQuantityRowIds],
      );

      const focusAdjacentQuantityInput = useCallback(
        (rowId: GridRowId, direction: "previous" | "next") => {
          const visibleRowIds = getVisibleQuantityRowIds();
          const adjacentRowId = getAdjacentVisibleQuantityRowId(
            visibleRowIds,
            rowId,
            direction,
          );
          focusQuantityInputByRowId(adjacentRowId);
        },
        [focusQuantityInputByRowId, getVisibleQuantityRowIds],
      );

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

        focusFirstQuantityInput();
        setPendingFocusRequestId(null);
        setCompletedFocusRequestId(null);
      }, [
        completedFocusRequestId,
        dataGridRows.length,
        focusFirstQuantityInput,
        paginationModel.page,
        pendingFocusRequestId,
      ]);

      useEffect(() => {
        return () => {
          clearFocusRetry();
          clearScheduledAutosize();
        };
      }, [clearFocusRetry, clearScheduledAutosize]);

      const createSkuDisplayName = useCallback(
        (sku: SkuWithDisplayInfo): string => {
          const parts: string[] = [sku.condition];
          if (sku.variant && sku.variant !== "Normal") {
            parts.push(sku.variant);
          }
          return parts.join(" ");
        },
        [],
      );

      const getActiveSku = useCallback(
        (availableSkus: SkuWithDisplayInfo[]): SkuWithDisplayInfo | null => {
          if (availableSkus.length === 0) {
            return null;
          }

          if (availableSkus[0]?.sealed) {
            return (
              availableSkus.find((sku) => sku.condition === "Unopened") ?? null
            );
          }

          return (
            availableSkus.find((sku) => sku.condition === selectedCondition) ??
            null
          );
        },
        [selectedCondition],
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
            ]),
          ),
        [skus],
      );

      const getSkuMetadata = useCallback(
        (sku: number) => {
          const metadata = skuMetadataBySku.get(sku);
          if (!metadata) {
            throw new Error(`SKU ${sku} not found in available skus`);
          }

          return metadata;
        },
        [skuMetadataBySku],
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
        [onUpdateQuantity, getSkuMetadata],
      );

      const handleQuickAdd = useCallback(
        (
          activeSku: SkuWithDisplayInfo | null,
          amount: number,
          returnFocus = true,
        ) => {
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
        [getCurrentPendingQuantity, onUpdateQuantity, getSkuMetadata],
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

      const getTcgPlayerImageUrl = useCallback(
        (productId: number, size = "200x200") => {
          return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_${size}.jpg`;
        },
        [],
      );

      const handleThumbnailClick = useCallback((productId: number) => {
        setSelectedProductId(productId);
        setImageDialogOpen(true);
      }, []);

      const handleCloseImageDialog = useCallback(() => {
        setImageDialogOpen(false);
        setSelectedProductId(null);
      }, []);

      const autosizeColumnFields = useMemo(
        (): AutosizedColumnField[] =>
          searchScope === "allSets" ? ["setName", "sku"] : ["sku"],
        [searchScope],
      );

      const autosizeOptions = useMemo(
        () => ({
          includeHeaders: true,
          includeOutliers: true,
          expand: false,
        }),
        [],
      );

      const syncAutosizedColumnWidths = useCallback(
        (fields: AutosizedColumnField[]) => {
          const gridApi = apiRef.current;

          if (!gridApi) {
            return;
          }

          const nextWidths = fields.reduce<
            Partial<Record<AutosizedColumnField, number>>
          >((widths, field) => {
            const column = gridApi.getColumn(field);
            const measuredWidth = Math.ceil(
              column.computedWidth ?? column.width ?? 0,
            );

            if (measuredWidth > 0) {
              widths[field] = measuredWidth;
            }

            return widths;
          }, {});

          setAutosizedColumnWidths((currentWidths) => {
            const mergedWidths = { ...currentWidths, ...nextWidths };
            const currentEntries = Object.entries(currentWidths);
            const mergedEntries = Object.entries(mergedWidths);

            if (
              currentEntries.length === mergedEntries.length &&
              mergedEntries.every(
                ([field, width]) =>
                  currentWidths[field as AutosizedColumnField] === width,
              )
            ) {
              return currentWidths;
            }

            return mergedWidths;
          });
        },
        [apiRef],
      );

      const runAutosize = useCallback(async () => {
        const gridApi = apiRef.current;

        if (!gridApi) {
          return;
        }

        if (autosizeInFlightRef.current) {
          autosizeQueuedRef.current = true;
          return;
        }

        autosizeInFlightRef.current = true;

        try {
          await gridApi.autosizeColumns({
            ...autosizeOptions,
            columns: autosizeColumnFields,
          });
          syncAutosizedColumnWidths(autosizeColumnFields);
        } finally {
          autosizeInFlightRef.current = false;

          if (autosizeQueuedRef.current) {
            autosizeQueuedRef.current = false;
            clearScheduledAutosize();

            autosizeFrameRef.current = window.requestAnimationFrame(() => {
              autosizeFrameRef.current = null;
              autosizeFollowUpFrameRef.current = window.requestAnimationFrame(
                () => {
                  autosizeFollowUpFrameRef.current = null;
                  void runAutosize();
                },
              );
            });
          }
        }
      }, [
        apiRef,
        autosizeColumnFields,
        autosizeOptions,
        clearScheduledAutosize,
        syncAutosizedColumnWidths,
      ]);

      const scheduleAutosize = useCallback(() => {
        clearScheduledAutosize();

        // Wait an extra frame so MUI can finish its own row-height/layout work
        // before measuring cell widths for autosizing.
        autosizeFrameRef.current = window.requestAnimationFrame(() => {
          autosizeFrameRef.current = null;
          autosizeFollowUpFrameRef.current = window.requestAnimationFrame(
            () => {
              autosizeFollowUpFrameRef.current = null;
              void runAutosize();
            },
          );
        });
      }, [clearScheduledAutosize, runAutosize]);

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
            width: autosizedColumnWidths.setName,
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
            width: autosizedColumnWidths.sku,
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

              return (
                <QuantityGridCell
                  rowId={params.id}
                  activeSku={activeSku}
                  currentQty={currentQty}
                  selectedCondition={selectedCondition}
                onQuantityChange={handleQuantityChange}
                onQuickAdd={handleQuickAdd}
                onFocusSearchInput={focusSearchInput}
                onFocusAdjacentQuantityInput={focusAdjacentQuantityInput}
                onChangeCondition={onChangeCondition}
                registerQuantityInput={registerQuantityInput}
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
                <ProductNameGridCell
                  value={params.value}
                  activeSku={activeSku}
                />
              );
            },
          },
        );

        return baseColumns;
      }, [
        createSkuDisplayName,
      focusAdjacentQuantityInput,
      focusSearchInput,
      getActiveSku,
      handleQuantityChange,
      handleQuickAdd,
      handleThumbnailClick,
      getCurrentPendingQuantity,
      onChangeCondition,
      registerQuantityInput,
      autosizedColumnWidths,
      searchScope,
        selectedCondition,
      ]);

      const resultSetSignature = useMemo(() => {
        return JSON.stringify({
          searchScope,
          allSetsSearchTerm,
          submittedProductNameFilter,
          rowIds: dataGridRows.map((row) => row.id),
        });
      }, [
        allSetsSearchTerm,
        dataGridRows,
        searchScope,
        submittedProductNameFilter,
      ]);

      const autosizeSignature = useMemo(() => {
        const pageStart = paginationModel.page * paginationModel.pageSize;
        const pageEnd = pageStart + paginationModel.pageSize;
        const currentPageRows = dataGridRows.slice(pageStart, pageEnd);

        return JSON.stringify({
          searchScope,
          selectedCondition,
          page: paginationModel.page,
          pageSize: paginationModel.pageSize,
          rows: currentPageRows.map((row) => {
            const activeSku = getActiveSku(row.skus);

            return {
              id: row.id,
              setLabel:
                searchScope === "allSets"
                  ? row.setReleaseYear
                    ? `${row.setName} - ${row.setReleaseYear}`
                    : row.setName
                  : null,
              skuLabel: activeSku
                ? createSkuDisplayName(activeSku)
                : `${selectedCondition} unavailable`,
            };
          }),
        });
      }, [
        createSkuDisplayName,
        dataGridRows,
        getActiveSku,
        paginationModel.page,
        paginationModel.pageSize,
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
      }, [paginationModel.page, resultSetSignature]);

      useEffect(() => {
        scheduleAutosize();
      }, [autosizeSignature, scheduleAutosize]);

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
                inputProps={{
                  "data-inventory-focus-id": "search",
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
                searchScope === "allSets" && allSetsSearchTerm
                  ? "warning"
                  : "info"
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
              <Box
                sx={{ mb: 2, display: "flex", gap: 1, alignItems: "center" }}
              >
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
                  autosizeOptions={{
                    ...autosizeOptions,
                    columns: autosizeColumnFields,
                  }}
                  paginationModel={paginationModel}
                  onPaginationModelChange={(model: GridPaginationModel) => {
                    setPaginationModel(model);
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
                      "200x200",
                    );
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
        </Box>
      );
    },
  );
