import React, {
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  Box,
  Autocomplete,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from "@mui/material";
import type { ProductLine } from "../data-types/productLine";
import type { CategorySet } from "../data-types/categorySet";

interface InventoryFiltersProps {
  productLines: ProductLine[];
  sets: CategorySet[];
  selectedProductLineId: number | null;
  selectedSetId: number | null;
  sealedFilter: "all" | "sealed" | "unsealed";
  onProductLineChange: (productLineId: number) => void;
  onSetChange: (setId: number) => void;
  onSealedFilterChange: (sealedFilter: "all" | "sealed" | "unsealed") => void;
}

// Ref interface for imperative methods
export interface InventoryFiltersRef {
  navigateSet: (direction: "previous" | "next") => void;
}

export const InventoryFilters = forwardRef<
  InventoryFiltersRef,
  InventoryFiltersProps
>(
  (
    {
      productLines,
      sets,
      selectedProductLineId,
      selectedSetId,
      sealedFilter,
      onProductLineChange,
      onSetChange,
      onSealedFilterChange,
    },
    ref
  ) => {
    // Sort product lines alphabetically
    const sortedProductLines = [...productLines].sort((a, b) =>
      a.productLineName.localeCompare(b.productLineName)
    );

    // Filter out inactive sets and sort alphabetically
    const sortedSets = [...sets]
      .filter((set) => !set.name.startsWith("[Inactive"))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Find selected values for autocomplete
    const selectedProductLine =
      sortedProductLines.find(
        (line) => line.productLineId === selectedProductLineId
      ) || null;

    const selectedSet =
      sortedSets.find((set) => set.setNameId === selectedSetId) || null;

    // Handle keyboard navigation for sets
    const handleSetNavigation = useCallback(
      (direction: "previous" | "next") => {
        if (sortedSets.length === 0) return;

        const currentIndex = sortedSets.findIndex(
          (set) => set.setNameId === selectedSetId
        );
        let nextIndex: number;

        if (direction === "previous") {
          nextIndex =
            currentIndex > 0 ? currentIndex - 1 : sortedSets.length - 1;
        } else {
          nextIndex =
            currentIndex < sortedSets.length - 1 ? currentIndex + 1 : 0;
        }

        const nextSet = sortedSets[nextIndex];
        if (nextSet) {
          onSetChange(nextSet.setNameId);
        }
      },
      [sortedSets, selectedSetId, onSetChange]
    );

    // Expose navigation function to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        navigateSet: handleSetNavigation,
      }),
      [handleSetNavigation]
    );

    return (
      <Box
        sx={{ display: "flex", gap: 2, flexWrap: "wrap", mb: 3, width: "100%" }}
      >
        <Autocomplete
          options={sortedProductLines}
          getOptionLabel={(option) => option.productLineName}
          value={selectedProductLine}
          onChange={(_, newValue) => {
            if (newValue) {
              onProductLineChange(newValue.productLineId);
            }
          }}
          sx={{ minWidth: 200, flex: 1 }}
          renderInput={(params) => (
            <TextField {...params} label="Product Line" />
          )}
        />

        <Autocomplete
          options={sortedSets}
          getOptionLabel={(option) => option.name}
          value={selectedSet}
          onChange={(_, newValue) => {
            if (newValue) {
              onSetChange(newValue.setNameId);
            }
          }}
          disabled={!selectedProductLineId}
          sx={{ minWidth: 200, flex: 1 }}
          renderInput={(params) => <TextField {...params} label="Set" />}
        />

        <FormControl sx={{ minWidth: 150, flex: 1 }}>
          <InputLabel>Product Type</InputLabel>
          <Select
            value={sealedFilter}
            label="Product Type"
            onChange={(e) =>
              onSealedFilterChange(
                e.target.value as "all" | "sealed" | "unsealed"
              )
            }
          >
            <MenuItem value="all">All Products</MenuItem>
            <MenuItem value="sealed">Sealed Only</MenuItem>
            <MenuItem value="unsealed">Unsealed Only</MenuItem>
          </Select>
        </FormControl>
      </Box>
    );
  }
);
