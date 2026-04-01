import React, { useCallback, useEffect, useRef } from "react";
import {
  Box,
  Typography,
  Paper,
  Button,
  Stack,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { useNavigate } from "react-router";
import { useInventoryProcessor } from "../hooks/useInventoryProcessor";
import {
  InventoryFilters,
  type InventoryFiltersRef,
} from "../components/InventoryFilters";
import { InventoryEntryTable } from "../components/InventoryEntryTable";
import {
  INVENTORY_CONDITION_ORDER,
  type InventorySelectableCondition,
} from "../../../core/utils/conditionOrder";

export default function InventoryManagerRoute() {
  const navigate = useNavigate();
  const {
    productLines,
    sets,
    pendingInventory,
    selectedProductLineId,
    selectedSetId,
    searchScope,
    allSetsSearchTerm,
    sealedFilter,
    selectedLanguages,
    selectedCondition,
    loadProductLines,
    loadSets,
    loadSkusByCardNumber,
    loadPendingInventory,
    updatePendingInventory,
    clearPendingInventory,
    createBatchFromPendingInventory,
    selectSet,
    setSearchScope,
    toggleSealedFilter,
    setSelectedLanguages,
    setSelectedCondition,
    cycleSelectedCondition,
    getFilteredSkus,
  } = useInventoryProcessor();

  const [clearDialogOpen, setClearDialogOpen] = React.useState(false);
  const [isCreatingBatch, setIsCreatingBatch] = React.useState(false);
  const filtersRef = useRef<InventoryFiltersRef>(null);

  useEffect(() => {
    loadProductLines();
    loadPendingInventory();
  }, [loadProductLines, loadPendingInventory]);

  const handleProductLineChange = (productLineId: number) => {
    loadSets(productLineId);
  };

  const handleSetChange = (setId: number) => {
    selectSet(setId);
  };

  const handleSearchScopeChange = (nextSearchScope: "set" | "allSets") => {
    setSearchScope(nextSearchScope);
  };

  const handleClearPendingInventory = () => {
    setClearDialogOpen(true);
  };

  const confirmClearPendingInventory = () => {
    clearPendingInventory();
    setClearDialogOpen(false);
  };

  const handleCreateBatch = async () => {
    setIsCreatingBatch(true);

    try {
      const batch = await createBatchFromPendingInventory();
      navigate(`/pending-inventory-pricer?batch=${batch.batchNumber}`);
    } catch (error) {
      console.error("Failed to create batch:", error);
    } finally {
      setIsCreatingBatch(false);
    }
  };

  const getPendingTotal = () => {
    return pendingInventory.reduce((sum, entry) => sum + entry.quantity, 0);
  };

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const target = event.target;
    const isEditableTarget =
      target instanceof HTMLElement &&
      Boolean(
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="combobox"]'
        )
      );

    if (!isEditableTarget && (event.key === "." || event.key === " ")) {
      event.preventDefault();
      cycleSelectedCondition();
      return;
    }

    if (event.key === "PageUp" && filtersRef.current) {
      event.preventDefault();
      filtersRef.current.navigateSet("previous");
    } else if (event.key === "PageDown" && filtersRef.current) {
      event.preventDefault();
      filtersRef.current.navigateSet("next");
    }
  }, [cycleSelectedCondition]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  return (
    <Box>
      <Box sx={{ maxWidth: 1200, mx: "auto", p: 3 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Inventory Manager
        </Typography>

        <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
          <Typography variant="h6" gutterBottom>
            Filter Products
          </Typography>
          <InventoryFilters
            ref={filtersRef}
            productLines={productLines}
            sets={sets}
            selectedProductLineId={selectedProductLineId}
            selectedSetId={selectedSetId}
            searchScope={searchScope}
            sealedFilter={sealedFilter}
            selectedLanguages={selectedLanguages}
            onProductLineChange={handleProductLineChange}
            onSetChange={handleSetChange}
            onSearchScopeChange={handleSearchScopeChange}
            onSealedFilterChange={toggleSealedFilter}
            onLanguagesChange={setSelectedLanguages}
          />
        </Paper>
      </Box>

      <Box sx={{ width: "100%", px: 3, mb: 3 }}>
        <Paper sx={{ p: 3 }} elevation={3}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 2,
              flexWrap: "wrap",
              mb: 2,
            }}
          >
            <Typography variant="h6">Add New Inventory</Typography>
            <Stack
              direction="row"
              spacing={2}
              alignItems="center"
              sx={{ flexWrap: "wrap", justifyContent: "flex-end" }}
            >
              <FormControl size="small" sx={{ minWidth: 220 }}>
                <InputLabel id="inventory-condition-label">
                  Entry Condition
                </InputLabel>
                <Select
                  labelId="inventory-condition-label"
                  value={selectedCondition}
                  label="Entry Condition"
                  onChange={(event) =>
                    setSelectedCondition(
                      event.target.value as InventorySelectableCondition
                    )
                  }
                >
                  {INVENTORY_CONDITION_ORDER.map((condition) => (
                    <MenuItem key={condition} value={condition}>
                      {condition}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Chip
                label="Shortcut: . or Space"
                variant="outlined"
                color="info"
              />
              {pendingInventory.length > 0 && (
                <Stack direction="row" spacing={2} alignItems="center">
                <Typography variant="body2" color="primary">
                  {getPendingTotal()} live items across {pendingInventory.length} SKUs
                </Typography>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  onClick={() => void handleCreateBatch()}
                  disabled={isCreatingBatch}
                >
                  {isCreatingBatch ? "Creating Batch..." : "Process & Price"}
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={handleClearPendingInventory}
                  size="small"
                  disabled={isCreatingBatch}
                >
                  Clear Live Queue
                </Button>
                </Stack>
              )}
            </Stack>
          </Box>

          <InventoryEntryTable
            skus={getFilteredSkus()}
            pendingInventory={pendingInventory}
            onUpdateQuantity={updatePendingInventory}
            searchScope={searchScope}
            allSetsSearchTerm={allSetsSearchTerm}
            selectedCondition={selectedCondition}
            onAllSetsSearch={(cardNumber) => {
              if (selectedProductLineId) {
                loadSkusByCardNumber(cardNumber, selectedProductLineId);
              }
            }}
            sealedFilter={sealedFilter}
          />
        </Paper>
      </Box>

      <Box sx={{ maxWidth: 1200, mx: "auto", px: 3 }} />

      <Dialog
        open={clearDialogOpen}
        onClose={() => setClearDialogOpen(false)}
        aria-labelledby="clear-dialog-title"
        aria-describedby="clear-dialog-description"
      >
        <DialogTitle id="clear-dialog-title">
          Clear Live Inventory Queue?
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="clear-dialog-description">
            Are you sure you want to clear all unbatched inventory entries? This
            will remove {getPendingTotal()} items from {pendingInventory.length}{" "}
            SKUs.
            <br />
            <br />
            Batches that have already been created are not affected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearDialogOpen(false)} color="primary">
            Cancel
          </Button>
          <Button
            onClick={confirmClearPendingInventory}
            color="secondary"
            variant="contained"
          >
            Clear Live Queue
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
