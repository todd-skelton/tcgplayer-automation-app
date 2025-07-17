import React from "react";
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

export const InventoryFilters: React.FC<InventoryFiltersProps> = ({
  productLines,
  sets,
  selectedProductLineId,
  selectedSetId,
  sealedFilter,
  onProductLineChange,
  onSetChange,
  onSealedFilterChange,
}) => {
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
        renderInput={(params) => <TextField {...params} label="Product Line" />}
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
};
