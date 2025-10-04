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
  Chip,
} from "@mui/material";
import type { ProductLine } from "../../../shared/data-types/productLine";
import type { CategorySet } from "../../../shared/data-types/categorySet";

// Available languages based on database analysis
const AVAILABLE_LANGUAGES = [
  "English",
  "Japanese",
  "French",
  "German",
  "Spanish",
  "Italian",
  "Chinese (S)",
  "Portuguese",
  "Chinese (T)",
  "Russian",
  "Korean",
];

interface InventoryFiltersProps {
  productLines: ProductLine[];
  sets: CategorySet[];
  selectedProductLineId: number | null;
  selectedSetId: number | null;
  sealedFilter: "all" | "sealed" | "unsealed";
  selectedLanguages: string[];
  onProductLineChange: (productLineId: number) => void;
  onSetChange: (setId: number) => void;
  onSealedFilterChange: (sealedFilter: "all" | "sealed" | "unsealed") => void;
  onLanguagesChange: (languages: string[]) => void;
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
      selectedLanguages,
      onProductLineChange,
      onSetChange,
      onSealedFilterChange,
      onLanguagesChange,
    },
    ref
  ) => {
    // Sort product lines alphabetically
    const sortedProductLines = [...productLines].sort((a, b) =>
      a.productLineName.localeCompare(b.productLineName)
    );

    // Filter out inactive sets and sort by release date descending (newest first)
    const sortedSets = [...sets]
      .filter((set) => !set.name.startsWith("[Inactive"))
      .sort((a, b) => {
        // Handle sets without release dates - put them at the end
        if (!a.releaseDate && !b.releaseDate) {
          return a.name.localeCompare(b.name);
        }
        if (!a.releaseDate) return 1;
        if (!b.releaseDate) return -1;

        // Sort by release date descending (newest first)
        const dateA = new Date(a.releaseDate);
        const dateB = new Date(b.releaseDate);
        return dateB.getTime() - dateA.getTime();
      });

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
      <Box sx={{ width: "100%" }}>
        {/* First row: Product Line, Product Type, and Languages */}
        <Box
          sx={{
            display: "flex",
            gap: 2,
            flexWrap: "wrap",
            mb: 2,
            width: "100%",
          }}
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

          <Autocomplete
            multiple
            options={AVAILABLE_LANGUAGES}
            value={selectedLanguages}
            onChange={(_, newValue) => {
              onLanguagesChange(newValue);
            }}
            sx={{ minWidth: 250, flex: 1 }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Languages"
                placeholder="All Languages"
              />
            )}
            renderTags={(value, getTagProps) =>
              value.map((option, index) => (
                <Chip
                  variant="outlined"
                  label={option}
                  size="small"
                  {...getTagProps({ index })}
                  key={option}
                />
              ))
            }
            getOptionLabel={(option) => option}
            limitTags={3}
            getLimitTagsText={(more) => `+${more} more`}
          />
        </Box>

        {/* Second row: Set with full width */}
        <Box sx={{ width: "100%" }}>
          <Autocomplete
            options={sortedSets}
            getOptionLabel={(option) => {
              const releaseDate = option.releaseDate
                ? ` (${new Date(option.releaseDate).toLocaleDateString()})`
                : "";
              return `${option.name}${releaseDate}`;
            }}
            value={selectedSet}
            onChange={(_, newValue) => {
              if (newValue) {
                onSetChange(newValue.setNameId);
              }
            }}
            disabled={!selectedProductLineId}
            sx={{ width: "100%" }}
            renderInput={(params) => <TextField {...params} label="Set" />}
          />
        </Box>
      </Box>
    );
  }
);
