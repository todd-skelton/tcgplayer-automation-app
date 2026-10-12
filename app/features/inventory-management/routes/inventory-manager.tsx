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
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Checkbox,
  FormControlLabel,
  Radio,
  RadioGroup,
} from "@mui/material";
import {
  DEFAULT_ESTIMATED_COST_RATE,
  describeEstimatedCostRate,
  marketPercentOf,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { CostRateFields, readCostRateInput, type CostRateInput } from "../components/CostRateFields";
import { Link } from "react-router";
import { InventoryIntakeProgress } from '../components/InventoryIntakeProgress';
import type { InventoryIntakeWorkflow, IntakePublicationTarget } from '../types/inventoryIntakeRun';
import { useInventoryProcessor } from "../hooks/useInventoryProcessor";
import {
  InventoryFilters,
  type InventoryFiltersRef,
} from "../components/InventoryFilters";
import { InventoryEntryTable } from "../components/InventoryEntryTable";
import { getConditionShortcutDirection } from "../components/quantityKeyboard";
import {
  INVENTORY_CONDITION_ORDER,
  type InventorySelectableCondition,
} from "../../../core/utils/conditionOrder";

type IntakeCostMethod = "estimate" | "cost_rate" | "purchase_total";

const DEFAULT_COST_RATE_INPUT: CostRateInput = {
  marketPercent: marketPercentOf(DEFAULT_ESTIMATED_COST_RATE),
  perCardDeduction: (DEFAULT_ESTIMATED_COST_RATE.perUnitDeductionCents / 100).toFixed(2),
};

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

  const [clearDialogOpen, setClearDialogOpen] = React.useState(false);
  const [isCreatingBatch, setIsCreatingBatch] = React.useState(false);
  const [queueRefreshKey, setQueueRefreshKey] = React.useState(0);
  const [intakeTarget, setIntakeTarget] = React.useState<IntakePublicationTarget | null>(null);
  const entryFocus = useRef<HTMLElement | null>(null);
  const [costMethod, setCostMethod] = React.useState<IntakeCostMethod>("estimate");
  const [costRateInput, setCostRateInput] = React.useState(DEFAULT_COST_RATE_INPUT);
  const [purchaseReference, setPurchaseReference] = React.useState("");
  const [purchaseTotal, setPurchaseTotal] = React.useState("");
  const [purchaseEstimated, setPurchaseEstimated] = React.useState(false);
  const [purchaseDate, setPurchaseDate] = React.useState("");
  const filtersRef = useRef<InventoryFiltersRef>(null);
  const costRate = readCostRateInput(costRateInput);
  const costRateBlocksQueue = costMethod === "cost_rate" && !costRate.valid;
  const queuedCost = costMethod === "purchase_total" ? "the entered purchase total"
    : costMethod === "cost_rate" && costRate.valid ? `an estimate at ${describeEstimatedCostRate(costRate.rate)}`
    : `an estimate at the default ${describeEstimatedCostRate(DEFAULT_ESTIMATED_COST_RATE)}`;

  const preserveFocusAcrossConditionChange = useCallback(
    (changeCondition: () => void) => {
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const focusId = activeElement?.dataset.inventoryFocusId ?? null;
      const selectionSnapshot =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
          ? {
              start: activeElement.selectionStart,
              end: activeElement.selectionEnd,
              direction: activeElement.selectionDirection,
            }
          : null;

      changeCondition();

      window.requestAnimationFrame(() => {
        const nextFocusTarget =
          focusId === null
            ? activeElement
            : Array.from(
                document.querySelectorAll<HTMLElement>(
                  "[data-inventory-focus-id]",
                ),
              ).find(
                (element) => element.dataset.inventoryFocusId === focusId,
              ) ?? activeElement;

        if (
          !(nextFocusTarget instanceof HTMLElement) ||
          !nextFocusTarget.isConnected
        ) {
          return;
        }

        nextFocusTarget.focus({ preventScroll: true });

        if (
          selectionSnapshot &&
          (nextFocusTarget instanceof HTMLInputElement ||
            nextFocusTarget instanceof HTMLTextAreaElement)
        ) {
          const maxSelectionIndex = nextFocusTarget.value.length;
          const start = Math.max(
            0,
            Math.min(selectionSnapshot.start ?? 0, maxSelectionIndex),
          );
          const end = Math.max(
            0,
            Math.min(selectionSnapshot.end ?? start, maxSelectionIndex),
          );

          nextFocusTarget.setSelectionRange(
            start,
            end,
            selectionSnapshot.direction ?? "none",
          );
        }
      });
    },
    [],
  );

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

  const handleCreateBatch = async (workflow: InventoryIntakeWorkflow = 'price_only') => {
    setIsCreatingBatch(true);
    // Recovery resends the saved request with its original cost choice, not the one on screen.
    const recovering = hasPendingIntakeRequest;

    try {
      const batch = await createBatchFromPendingInventory(costMethod === "purchase_total" ? {
        purchaseReference: purchaseReference.trim(), totalAmount: purchaseTotal.trim(),
        provenance: purchaseEstimated ? "estimated" : "actual", allocationRule: "quantity",
        ...(purchaseDate ? { purchasedAt: purchaseDate } : {}), currency: "USD",
      } : undefined, workflow, intakeTarget?.sellerKey ?? '', costMethod === "cost_rate" ? {
        marketPercent: costRateInput.marketPercent.trim(), perCardDeduction: costRateInput.perCardDeduction.trim(),
      } : undefined);
      setQueueRefreshKey(value => value + 1);
      if (recovering) {
        setSuccess(`Batch ${batch.batchNumber} queued with its original cost choice. You can keep adding inventory.`);
        return;
      }
      setSuccess(`Batch ${batch.batchNumber} queued with ${queuedCost}. You can keep adding inventory.`);
      // A cost rate describes the whole lot, so it stays for the next handoff; a total belongs to one.
      if (costMethod === "purchase_total") setCostMethod("estimate");
      setPurchaseReference('');
      setPurchaseTotal('');
      setPurchaseDate('');
      setPurchaseEstimated(false);
    } catch (error) {
      console.error("Failed to create batch:", error);
    } finally {
      setIsCreatingBatch(false);
      window.requestAnimationFrame(() => {
        if (entryFocus.current?.isConnected) entryFocus.current.focus({ preventScroll: true });
      });
    }
  };

  const getPendingTotal = () => {
    return pendingInventory.reduce((sum, entry) => sum + entry.quantity, 0);
  };

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // React's root listener also lives on document, so a focused quantity
      // input that already handled this shortcut cannot stop it reaching here.
      if (event.defaultPrevented) {
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
    <Box>
      <Box sx={{ maxWidth: 1200, mx: "auto", p: 3 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Inventory Manager
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}
        {hasPendingIntakeRequest && <Alert severity="warning" sx={{ mb: 2 }}
          action={<Button disabled={isCreatingBatch} onClick={() => void handleCreateBatch()}>Recover Queue Request</Button>}>
          A queue request has not been confirmed. Recover the original request before entering more inventory. Its original pricing, publication, and cost choices are preserved.
        </Alert>}
        <InventoryIntakeProgress refreshKey={queueRefreshKey} onTarget={setIntakeTarget} />
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
        <Paper component="fieldset" disabled={intakeBlocked || isCreatingBatch} sx={{ p: 3, m: 0, minWidth: 0, border: 0 }} elevation={3}>
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
                      event.target.value as InventorySelectableCondition,
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
                label="Shortcut: Ctrl+Up / Ctrl+Down (Cmd on Mac)"
                variant="outlined"
                color="info"
              />
              {pendingInventory.length > 0 && (
                <Stack direction="row" spacing={2} alignItems="center">
                  <Typography variant="body2" color="primary">
                    {getPendingTotal()} unqueued units across{" "}
                    {pendingInventory.length} SKUs
                  </Typography>
                  <Button
                    variant="outlined"
                    color="primary"
                    size="small"
                    onPointerDown={() => { entryFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
                    onClick={() => void handleCreateBatch('publish')}
                    disabled={isCreatingBatch || costRateBlocksQueue || !intakeTarget?.canPublish}
                  >
                    {isCreatingBatch ? "Saving & Queuing..." : "Queue Pricing & Publishing"}
                  </Button>
                  <Button variant="contained" size="small" disabled={isCreatingBatch || costRateBlocksQueue || !intakeTarget}
                    onPointerDown={() => { entryFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
                    onClick={() => void handleCreateBatch('price_only')}>Queue Pricing Only</Button>
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

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queuing hands off the displayed quantities. If the shared queue changes, you must review it again. New additions go into the next batch.
            Pricing &amp; Publishing authorizes eligible results to go live for seller {intakeTarget?.sellerKey || '(not configured)'}, subject to publication safety controls.
            Pricing Only waits for manual publication. <Link to="/pending-inventory-pricer">Open Batch Pricer</Link>.
          </Typography>
          {intakeTarget?.publishingUnavailableReason && <Alert severity="warning" sx={{ mb: 2 }}>{intakeTarget.publishingUnavailableReason} <Link to="/publication-configuration">Publication settings</Link>.</Alert>}
          <Box component="section" aria-labelledby="batch-cost-heading" sx={{ mb: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1 }}>
            <FormControl>
              <Typography id="batch-cost-heading" variant="subtitle2">Cost of the next batch</Typography>
              <RadioGroup row value={costMethod} aria-labelledby="batch-cost-heading"
                onChange={(event) => setCostMethod(event.target.value as IntakeCostMethod)}>
                <FormControlLabel value="estimate" control={<Radio size="small" />}
                  label={`Default estimate: ${describeEstimatedCostRate(DEFAULT_ESTIMATED_COST_RATE)}`} />
                <FormControlLabel value="cost_rate" control={<Radio size="small" />} label="My own rate" />
                <FormControlLabel value="purchase_total" control={<Radio size="small" />} label="Purchase total" />
              </RadioGroup>
            </FormControl>
            {costMethod === "cost_rate" && (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <CostRateFields value={costRateInput} onChange={setCostRateInput} />
                <Typography variant="caption" color="text.secondary">
                  The rate stays selected for later batches of this lot until you change it or reload the page. It also costs cards whose market price is found after intake, and you can change a queued batch's rate in Background inventory batches.
                </Typography>
              </Stack>
            )}
            {costMethod === "purchase_total" && (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                  <TextField label="Purchase reference" value={purchaseReference} required size="small"
                    onChange={(event) => setPurchaseReference(event.target.value)} />
                  <TextField label="Purchase total (USD)" value={purchaseTotal} required size="small"
                    inputMode="decimal" onChange={(event) => setPurchaseTotal(event.target.value)} />
                  <TextField label="Purchase date" type="date" value={purchaseDate} size="small"
                    slotProps={{ inputLabel: { shrink: true } }} onChange={(event) => setPurchaseDate(event.target.value)} />
                  <FormControlLabel control={<Checkbox checked={purchaseEstimated}
                    onChange={(event) => setPurchaseEstimated(event.target.checked)} />}
                    label="Estimated" />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Enter only this handoff's share if the purchase is split across batches. It is split across the cards by quantity and clears after the batch is queued.
                </Typography>
              </Stack>
            )}
            <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>
              Cost feeds margins and Inventory Economics; pricing does not use it. Estimates use each card's market price at intake, so a card worth less than the amount per card counts as negative cost.
            </Typography>
          </Box>
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
