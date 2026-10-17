import React, {
  useEffect,
  useCallback,
  useImperativeHandle,
  useState,
  forwardRef,
} from "react";
import {
  Box,
  Autocomplete,
  Button,
  Collapse,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  FormControlLabel,
  Switch,
} from "@mui/material";
import FilterListIcon from "@mui/icons-material/FilterList";
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
  searchScope: "set" | "allSets";
  sealedFilter: "all" | "sealed" | "unsealed";
  selectedLanguages: string[];
  onProductLineChange: (productLineId: number) => void;
  onSetChange: (setId: number) => void;
  onSearchScopeChange: (searchScope: "set" | "allSets") => void;
  onSealedFilterChange: (sealedFilter: "all" | "sealed" | "unsealed") => void;
  onLanguagesChange: (languages: string[]) => void;
  /** Controls shown at the end of the main filter row. */
  children?: React.ReactNode;
}

/** What the filters behind "More filters" are doing, for example "Unsealed only, English". */
export function describeMoreFilters(
  sealedFilter: "all" | "sealed" | "unsealed",
  languages: string[],
): string | null {
  const parts = [
    sealedFilter === "sealed" ? "Sealed only" : sealedFilter === "unsealed" ? "Unsealed only" : null,
    languages.length === 0 ? null : languages.length <= 2 ? languages.join(", ") : `${languages.length} languages`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
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
      searchScope,
      sealedFilter,
      selectedLanguages,
      onProductLineChange,
      onSetChange,
      onSearchScopeChange,
      onSealedFilterChange,
      onLanguagesChange,
      children,
    },
    ref
  ) => {
    const [moreOpen, setMoreOpen] = useState(false);
    const moreFilters = describeMoreFilters(sealedFilter, selectedLanguages);

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
        <Box
          sx={{
            display: "flex",
            gap: 2,
            flexWrap: "wrap",
            alignItems: "center",
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
          <Autocomplete
            options={sortedSets}
            getOptionLabel={(option) => {
              const abbreviation = option.abbreviation
                ? `${option.abbreviation} - `
                : "";
              const releaseDate = option.releaseDate
                ? ` - ${new Date(option.releaseDate).toLocaleDateString()}`
                : "";
              return `${abbreviation}${option.name}${releaseDate}`;
            }}
            value={selectedSet}
            onChange={(_, newValue) => {
              if (newValue) {
                onSetChange(newValue.setNameId);
              }
            }}
            disabled={!selectedProductLineId}
            sx={{ minWidth: 280, flex: 2 }}
            renderInput={(params) => <TextField {...params} label="Set" />}
          />
          <FormControlLabel
            control={
              <Switch
                checked={searchScope === "allSets"}
                onChange={(_, checked) =>
                  onSearchScopeChange(checked ? "allSets" : "set")
                }
                disabled={!selectedProductLineId}
              />
            }
            label="All sets"
            sx={{ mr: 0 }}
          />
          {children}
          <Button
            variant={moreOpen ? "contained" : "outlined"}
            startIcon={<FilterListIcon />}
            aria-expanded={moreOpen}
            aria-controls="inventory-more-filters"
            onClick={() => setMoreOpen((open) => !open)}
            sx={{ textTransform: "none" }}
          >
            More filters{moreFilters ? `: ${moreFilters}` : ""}
          </Button>
        </Box>

        <Collapse in={moreOpen} id="inventory-more-filters">
          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", pt: 2 }}>
            <FormControl sx={{ minWidth: 180 }}>
              <InputLabel id="inventory-product-type-label">Product Type</InputLabel>
              <Select
                labelId="inventory-product-type-label"
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
              sx={{ minWidth: 250, flex: 1, maxWidth: 560 }}
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
        </Collapse>
      </Box>
    );
  }
);
