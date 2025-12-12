import React, { useEffect, useCallback, useRef } from "react";
import {
  Box,
  Typography,
  Paper,
  Button,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { Link } from "react-router";
import { useInventoryProcessor } from "../hooks/useInventoryProcessor";
import {
  InventoryFilters,
  type InventoryFiltersRef,
} from "../components/InventoryFilters";
import { InventoryEntryTable } from "../components/InventoryEntryTable";

export default function InventoryManagerRoute() {
  const {
    productLines,
    sets,
    skus,
    pendingInventory,
    selectedProductLineId,
    selectedSetId,
    sealedFilter,
    selectedLanguages,
    loadProductLines,
    loadSets,
    loadSkus,
    loadPendingInventory,
    updatePendingInventory,
    clearPendingInventory,
    toggleSealedFilter,
    setSelectedLanguages,
    getFilteredSkus,
    getAvailableLanguages,
  } = useInventoryProcessor();

  const [clearDialogOpen, setClearDialogOpen] = React.useState(false);
  const filtersRef = useRef<InventoryFiltersRef>(null);

  useEffect(() => {
    loadProductLines();
    loadPendingInventory();
  }, [loadProductLines, loadPendingInventory]);

  const handleProductLineChange = (productLineId: number) => {
    loadSets(productLineId);
  };

  const handleSetChange = (setId: number) => {
    loadSkus(setId);
  };

  const handleClearPendingInventory = () => {
    setClearDialogOpen(true);
  };

  const confirmClearPendingInventory = () => {
    clearPendingInventory();
    setClearDialogOpen(false);
  };

  const getPendingTotal = () => {
    return pendingInventory.reduce((sum, entry) => sum + entry.quantity, 0);
  };

  // Handle global keyboard shortcuts for set navigation
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "PageUp" && filtersRef.current) {
      event.preventDefault();
      filtersRef.current.navigateSet("previous");
    } else if (event.key === "PageDown" && filtersRef.current) {
      event.preventDefault();
      filtersRef.current.navigateSet("next");
    }
  }, []);

  // Add global keyboard listener
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  return (
    <Box>
      {/* Header and Filters - constrained width */}
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
            sealedFilter={sealedFilter}
            selectedLanguages={selectedLanguages}
            onProductLineChange={handleProductLineChange}
            onSetChange={handleSetChange}
            onSealedFilterChange={toggleSealedFilter}
            onLanguagesChange={setSelectedLanguages}
          />
        </Paper>
      </Box>
      {/* Inventory Entry - full width */}
      <Box sx={{ width: "100%", px: 3, mb: 3 }}>
        <Paper sx={{ p: 3 }} elevation={3}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2,
            }}
          >
            <Typography variant="h6">Add New Inventory</Typography>
            {pendingInventory.length > 0 && (
              <Stack direction="row" spacing={2} alignItems="center">
                <Typography variant="body2" color="primary">
                  {getPendingTotal()} items pending across{" "}
                  {pendingInventory.length} SKUs
                </Typography>
                <Button
                  component={Link}
                  to="/pending-inventory-pricer"
                  variant="contained"
                  color="primary"
                  size="small"
                >
                  Process & Price
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  onClick={handleClearPendingInventory}
                  size="small"
                >
                  Clear All
                </Button>
              </Stack>
            )}
          </Box>

          <InventoryEntryTable
            skus={getFilteredSkus()}
            pendingInventory={pendingInventory}
            onUpdateQuantity={updatePendingInventory}
            sealedFilter={sealedFilter}
          />
        </Paper>
      </Box>{" "}
      {/* Processing Controls and other sections - constrained width */}
      <Box sx={{ maxWidth: 1200, mx: "auto", px: 3 }}></Box>
      {/* Clear Pending Inventory Confirmation Dialog */}
      <Dialog
        open={clearDialogOpen}
        onClose={() => setClearDialogOpen(false)}
        aria-labelledby="clear-dialog-title"
        aria-describedby="clear-dialog-description"
      >
        <DialogTitle id="clear-dialog-title">
          Clear Pending Inventory?
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="clear-dialog-description">
            Are you sure you want to clear all pending inventory entries? This
            will remove {getPendingTotal()} items from {pendingInventory.length}{" "}
            SKUs.
            <br />
            <br />
            <strong>Note:</strong> Pending inventory is automatically cleared
            when you successfully process and download a CSV file.
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
            Clear All
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
