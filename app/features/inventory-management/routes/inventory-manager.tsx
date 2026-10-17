import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { useInventoryProcessor } from "../hooks/useInventoryProcessor";
import { useIntakeRuns } from "../hooks/useIntakeRuns";
import {
  InventoryFilters,
  type InventoryFiltersRef,
} from "../components/InventoryFilters";
import { InventoryEntryTable } from "../components/InventoryEntryTable";
import { EntryConditionSelect } from "../components/EntryConditionSelect";
import { BackgroundBatches } from "../components/BackgroundBatches";
import { InventoryHelp } from "../components/InventoryHelp";
import { QueueBar } from "../components/QueueBar";
import { getConditionShortcutDirection } from "../components/quantityKeyboard";
import {
  captureEntryFocus,
  restoreEntryFocus,
  type EntryFocus,
} from "../components/entryFocus";
import {
  DEFAULT_NEXT_BATCH_COST,
  describeQueuedCost,
  nextBatchCostAfterQueue,
  nextBatchCostRequest,
} from "../services/nextBatchCost";
import type { InventoryIntakeWorkflow } from "../types/inventoryIntakeRun";

export default function InventoryManagerRoute() {
  const {
    productLines,
    sets,
    pendingInventory,
    error,
    success,
    setSuccess,
    intakeBlocked,
    hasPendingIntakeRequest,
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
    adjustPendingInventory,
    setPendingInventory,
    clearPendingInventory,
    createBatchFromPendingInventory,
    selectSet,
    setSearchScope,
    toggleSealedFilter,
    setSelectedLanguages,
    setSelectedCondition,
    selectPreviousCondition,
    selectNextCondition,
    getFilteredSkus,
  } = useInventoryProcessor();
  const intake = useIntakeRuns();

  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [isCreatingBatch, setIsCreatingBatch] = useState(false);
  const [nextCost, setNextCost] = useState(DEFAULT_NEXT_BATCH_COST);
  const [workflow, setWorkflow] = useState<InventoryIntakeWorkflow>("price_only");
  const filtersRef = useRef<InventoryFiltersRef>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const entryRegionRef = useRef<HTMLDivElement>(null);

  // The last place inventory was entered, so queuing and clearing hand focus back to it.
  const entryFocus = useRef<EntryFocus | null>(null);
  const entryFocusPending = useRef(false);
  const [entryFocusRequest, setEntryFocusRequest] = useState(0);
  const returnToEntry = useCallback(() => {
    entryFocusPending.current = true;
    setEntryFocusRequest((value) => value + 1);
  }, []);

  useEffect(() => {
    const region = entryRegionRef.current;
    if (!region) return;
    const remember = (event: FocusEvent) => {
      entryFocus.current = captureEntryFocus(event.target) ?? entryFocus.current;
    };
    region.addEventListener("focusin", remember);
    return () => region.removeEventListener("focusin", remember);
  }, []);

  // Waits until the entry fieldset is enabled again, so the inputs can take focus.
  useEffect(() => {
    if (!entryFocusPending.current || isCreatingBatch || intakeBlocked) return;
    const frame = window.requestAnimationFrame(() => {
      entryFocusPending.current = false;
      restoreEntryFocus(entryFocus.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entryFocusRequest, isCreatingBatch, intakeBlocked]);

  const preserveFocusAcrossConditionChange = useCallback(
    (changeCondition: () => void) => {
      const focus = captureEntryFocus(document.activeElement);
      changeCondition();
      window.requestAnimationFrame(() =>
        restoreEntryFocus(focus, { withSelection: true }),
      );
    },
    [],
  );

  useEffect(() => {
    loadProductLines();
    loadPendingInventory();
  }, [loadProductLines, loadPendingInventory]);

  const confirmClearPendingInventory = () => {
    clearPendingInventory();
    setClearDialogOpen(false);
    returnToEntry();
  };

  const handleCreateBatch = async (chosenWorkflow: InventoryIntakeWorkflow = "price_only") => {
    setIsCreatingBatch(true);
    // Recovery resends the saved request with its original cost choice, not the one on screen.
    const recovering = hasPendingIntakeRequest;
    const queuedCost = describeQueuedCost(nextCost);
    const cost = nextBatchCostRequest(nextCost);

    try {
      const batch = await createBatchFromPendingInventory(
        cost.purchaseCost,
        chosenWorkflow,
        intake.target?.sellerKey ?? "",
        cost.estimatedCostRate,
      );
      intake.reload();
      if (recovering) {
        setSuccess(`Batch ${batch.batchNumber} queued with its original cost choice. You can keep adding inventory.`);
        return;
      }
      setSuccess(`Batch ${batch.batchNumber} queued with ${queuedCost}. You can keep adding inventory.`);
      setNextCost(nextBatchCostAfterQueue);
    } catch (error) {
      console.error("Failed to create batch:", error);
    } finally {
      setIsCreatingBatch(false);
      returnToEntry();
    }
  };

  const pendingTotal = pendingInventory.reduce((sum, entry) => sum + entry.quantity, 0);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // React's root listener also lives on document, so a focused quantity
      // input that already handled this shortcut cannot stop it reaching here.
      if (event.defaultPrevented) {
        return;
      }

      // Dialogs, menus, and drawers render outside the page; their keys are their own.
      const target = event.target;
      if (
        target instanceof Node &&
        target !== document.body &&
        !pageRef.current?.contains(target)
      ) {
        return;
      }

      const conditionDirection = getConditionShortcutDirection(event);
      if (conditionDirection) {
        event.preventDefault();
        preserveFocusAcrossConditionChange(
          conditionDirection === "previous"
            ? selectPreviousCondition
            : selectNextCondition,
        );
        return;
      }

      if (event.altKey || event.metaKey) {
        return;
      }

      if (event.key === "PageUp" && filtersRef.current) {
        event.preventDefault();
        filtersRef.current.navigateSet("previous");
      } else if (event.key === "PageDown" && filtersRef.current) {
        event.preventDefault();
        filtersRef.current.navigateSet("next");
      }
    },
    [
      preserveFocusAcrossConditionChange,
      selectNextCondition,
      selectPreviousCondition,
    ],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  return (
    <Box
      ref={pageRef}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        px: 3,
        py: 2,
        boxSizing: "border-box",
        height: { md: "calc(100dvh - 64px)" },
      }}
    >
      <Stack spacing={2} sx={{ flexShrink: 0 }}>
        <Stack direction="row" alignItems="center" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Typography variant="h5" component="h1" sx={{ flex: 1 }}>
            Inventory Manager
          </Typography>
          <BackgroundBatches
            runs={intake.runs}
            error={intake.error}
            publicationPaused={intake.target?.publicationPaused ?? false}
            onRunChanged={intake.reload}
          />
          <InventoryHelp />
        </Stack>

        {error && <Alert severity="error">{error}</Alert>}
        {hasPendingIntakeRequest && (
          <Alert
            severity="warning"
            action={
              <Button disabled={isCreatingBatch} onClick={() => void handleCreateBatch()}>
                Recover Queue Request
              </Button>
            }
          >
            A queue request has not been confirmed. Recover the original request before entering more inventory. Its
            original pricing, publication, and cost choices are preserved.
          </Alert>
        )}

        <Paper component="section" aria-label="Filters" sx={{ p: 2 }} elevation={2}>
          <InventoryFilters
            ref={filtersRef}
            productLines={productLines}
            sets={sets}
            selectedProductLineId={selectedProductLineId}
            selectedSetId={selectedSetId}
            searchScope={searchScope}
            sealedFilter={sealedFilter}
            selectedLanguages={selectedLanguages}
            onProductLineChange={loadSets}
            onSetChange={selectSet}
            onSearchScopeChange={setSearchScope}
            onSealedFilterChange={toggleSealedFilter}
            onLanguagesChange={setSelectedLanguages}
          >
            <EntryConditionSelect value={selectedCondition} onChange={setSelectedCondition} />
          </InventoryFilters>
        </Paper>
      </Stack>

      <Box
        component="fieldset"
        aria-label="Add new inventory"
        disabled={intakeBlocked || isCreatingBatch}
        sx={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, minWidth: 0, m: 0, p: 0, border: 0 }}
      >
        <Paper
          ref={entryRegionRef}
          elevation={2}
          sx={{ p: 2, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          <InventoryEntryTable
            skus={getFilteredSkus()}
            pendingInventory={pendingInventory}
            onAdjustQuantity={adjustPendingInventory}
            onSetQuantity={setPendingInventory}
            searchScope={searchScope}
            allSetsSearchTerm={allSetsSearchTerm}
            selectedCondition={selectedCondition}
            onChangeCondition={(direction) =>
              preserveFocusAcrossConditionChange(
                direction === "previous"
                  ? selectPreviousCondition
                  : selectNextCondition,
              )
            }
            onAllSetsSearch={async (searchText) => {
              if (selectedProductLineId) {
                await loadSkusByCardNumber(searchText, selectedProductLineId);
              }
            }}
            sealedFilter={sealedFilter}
          />
        </Paper>
        {pendingInventory.length > 0 && (
          <QueueBar
            units={pendingTotal}
            skuCount={pendingInventory.length}
            cost={nextCost}
            onCostChange={setNextCost}
            workflow={workflow}
            onWorkflowChange={setWorkflow}
            target={intake.target}
            queuing={isCreatingBatch}
            onQueue={(chosenWorkflow) => void handleCreateBatch(chosenWorkflow)}
            onClear={() => setClearDialogOpen(true)}
          />
        )}
      </Box>

      <Snackbar
        open={Boolean(success)}
        autoHideDuration={8000}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        sx={{ mt: 7 }}
        onClose={(_, reason) => {
          if (reason !== "clickaway") setSuccess(null);
        }}
      >
        <Alert severity="success" variant="filled" onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      </Snackbar>

      <Dialog
        open={clearDialogOpen}
        onClose={() => setClearDialogOpen(false)}
        aria-labelledby="clear-dialog-title"
        aria-describedby="clear-dialog-description"
      >
        <DialogTitle id="clear-dialog-title">Clear unqueued inventory?</DialogTitle>
        <DialogContent>
          <DialogContentText id="clear-dialog-description">
            This removes {pendingTotal} units across {pendingInventory.length} SKUs that have not been queued yet.
            <br />
            <br />
            Batches that have already been queued are not affected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearDialogOpen(false)} color="primary">
            Cancel
          </Button>
          <Button onClick={confirmClearPendingInventory} color="secondary" variant="contained">
            Clear unqueued
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
