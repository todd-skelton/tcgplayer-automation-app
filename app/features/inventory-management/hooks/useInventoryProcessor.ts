import { useState, useCallback, useRef } from "react";
import type { InventoryEntry, InventoryFilter } from "../types/inventoryEntry";
import type { PendingInventoryEntry } from "../../pending-inventory/types/pendingInventory";
import type { InventoryBatch } from "../../pending-inventory/types/inventoryBatch";
import type { ProductLine } from "../../../shared/data-types/productLine";
import type { CategorySet } from "../../../shared/data-types/categorySet";
import type { Sku } from "../../../shared/data-types/sku";
import { useProcessorBase } from "../../file-upload/hooks/useProcessorBase";
import {
  getNextInventoryCondition,
  getPreviousInventoryCondition,
  type InventorySelectableCondition,
} from "../../../core/utils/conditionOrder";
import { InventoryMutationState } from "../services/inventoryMutationState";
import {
  createPendingInventoryBatch,
  PendingBatchRequestError,
  type PurchaseCostAtIntake,
} from "../services/createPendingInventoryBatch";

// Extended interface for SKUs with display information
interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
  setNameId?: number;
  setReleaseDate?: string;
}

export interface InventoryProcessorState {
  // Inventory specific state
  productLines: ProductLine[];
  sets: CategorySet[];
  skus: SkuWithDisplayInfo[];
  currentInventory: InventoryEntry[];
  pendingInventory: PendingInventoryEntry[]; // Changed from Map to array

  // Filters
  selectedProductLineId: number | null;
  selectedSetId: number | null;
  searchScope: "set" | "allSets";
  allSetsSearchTerm: string;
  sealedFilter: "all" | "sealed" | "unsealed";
  selectedLanguages: string[];
  selectedCondition: InventorySelectableCondition;
}

export interface InventoryProcessorReturn extends InventoryProcessorState {
  // Base processor state
  isProcessing: boolean;
  progress: any;
  error: string | null;
  warning: string | null;
  success: string | null;
  summary: any;

  // Methods
  setError: (error: string | null) => void;
  setWarning: (warning: string | null) => void;
  setSuccess: (success: string | null) => void;
  loadProductLines: () => Promise<void>;
  loadSets: (productLineId: number) => Promise<void>;
  loadSkus: (setId: number, productLineId: number) => Promise<void>;
  loadSkusByCardNumber: (
    cardNumber: string,
    productLineId: number
  ) => Promise<void>;
  selectSet: (setId: number) => Promise<void>;
  setSearchScope: (searchScope: "set" | "allSets") => Promise<void>;
  loadCurrentInventory: () => Promise<void>;
  loadPendingInventory: () => Promise<void>;
  adjustPendingInventory: (
    sku: number,
    quantityDelta: number,
    metadata: { productLineId: number; setId: number; productId: number }
  ) => void;
  setPendingInventory: (
    sku: number,
    quantity: number,
    expectedQuantity: number,
    metadata: { productLineId: number; setId: number; productId: number }
  ) => void;
  clearPendingInventory: () => void;
  createBatchFromPendingInventory: (purchaseCost?: PurchaseCostAtIntake) => Promise<InventoryBatch>;
  toggleSealedFilter: (sealedFilter: "all" | "sealed" | "unsealed") => void;
  setSelectedLanguages: (languages: string[]) => void;
  setSelectedCondition: (condition: InventorySelectableCondition) => void;
  selectPreviousCondition: () => void;
  selectNextCondition: () => void;
  getFilteredSkus: () => SkuWithDisplayInfo[];
  getAvailableLanguages: () => string[];
}

export const useInventoryProcessor = (): InventoryProcessorReturn => {
  const baseProcessor = useProcessorBase();
  const inventoryMutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const inventoryMutationState = useRef(new InventoryMutationState());
  const pendingBatchRequestId = useRef<string | null>(null);
  const [state, setState] = useState<InventoryProcessorState>({
    productLines: [],
    sets: [],
    skus: [],
    currentInventory: [],
    pendingInventory: [],
    selectedProductLineId: null,
    selectedSetId: null,
    searchScope: "set",
    allSetsSearchTerm: "",
    sealedFilter: "unsealed", // Default to Unsealed
    selectedLanguages: [],
    selectedCondition: "Near Mint",
  });

  const loadSkus = useCallback(async (setId: number, productLineId: number) => {
    try {
      // Load SKUs for the selected set
      // Include productLineId for a targeted lookup
      const skusResponse = await fetch(
        `/api/inventory/skus-by-set?setId=${setId}&productLineId=${productLineId}`
      );

      if (!skusResponse.ok) throw new Error("Failed to load SKUs");

      const skus = await skusResponse.json();

      setState((prev) => ({
        ...prev,
        skus,
        selectedSetId: setId,
        searchScope: "set",
        allSetsSearchTerm: "",
      }));
    } catch (error) {
      baseProcessor.setError(`Failed to load SKUs: ${error}`);
    }
  }, []);

  const loadSkusByCardNumber = useCallback(
    async (cardNumber: string, productLineId: number) => {
      const trimmedCardNumber = cardNumber.trim();

      if (!trimmedCardNumber) {
        setState((prev) => ({
          ...prev,
          skus: [],
          allSetsSearchTerm: "",
        }));
        return;
      }

      try {
        const skusResponse = await fetch(
          `/api/inventory/skus-by-card-number?productLineId=${productLineId}&cardNumber=${encodeURIComponent(trimmedCardNumber)}`
        );

        if (!skusResponse.ok) throw new Error("Failed to load SKUs");

        const skus = await skusResponse.json();

        setState((prev) => ({
          ...prev,
          skus,
          allSetsSearchTerm: trimmedCardNumber,
        }));
      } catch (error) {
        baseProcessor.setError(`Failed to load SKUs: ${error}`);
      }
    },
    [baseProcessor]
  );

  const selectSet = useCallback(
    async (setId: number) => {
      if (!state.selectedProductLineId) {
        setState((prev) => ({ ...prev, selectedSetId: setId }));
        return;
      }

      if (state.searchScope === "allSets") {
        setState((prev) => ({ ...prev, selectedSetId: setId }));
        return;
      }

      await loadSkus(setId, state.selectedProductLineId);
    },
    [loadSkus, state.searchScope, state.selectedProductLineId]
  );

  const setSearchScope = useCallback(
    async (searchScope: "set" | "allSets") => {
      if (searchScope === "allSets") {
        setState((prev) => ({
          ...prev,
          searchScope,
          skus: [],
          allSetsSearchTerm: "",
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        searchScope,
        allSetsSearchTerm: "",
        skus: [],
      }));

      if (state.selectedProductLineId && state.selectedSetId) {
        await loadSkus(state.selectedSetId, state.selectedProductLineId);
      } else {
        setState((prev) => ({ ...prev, skus: [] }));
      }
    },
    [loadSkus, state.selectedProductLineId, state.selectedSetId]
  );

  const loadSets = useCallback(
    async (productLineId: number) => {
      try {
        const response = await fetch(
          `/api/inventory/sets?productLineId=${productLineId}`
        );
        if (!response.ok) throw new Error("Failed to load sets");
        const sets = await response.json();

        // Filter out inactive sets and sort by release date descending
        const activeSets = sets
          .filter((set: CategorySet) => !set.name.startsWith("[Inactive"))
          .sort((a: CategorySet, b: CategorySet) => {
            if (!a.releaseDate && !b.releaseDate) return 0;
            if (!a.releaseDate) return 1;
            if (!b.releaseDate) return -1;
            return (
              new Date(b.releaseDate).getTime() -
              new Date(a.releaseDate).getTime()
            );
          });

        // Auto-select the latest set (first one after sorting)
        const latestSet = activeSets.length > 0 ? activeSets[0] : null;

        setState((prev) => ({
          ...prev,
          sets,
          selectedProductLineId: productLineId,
          selectedSetId: latestSet?.setNameId || null,
          searchScope: "set",
          allSetsSearchTerm: "",
          skus: [],
        }));

        // Auto-load SKUs for the latest set
        if (latestSet) {
          loadSkus(latestSet.setNameId, productLineId);
        }
      } catch (error) {
        baseProcessor.setError(`Failed to load sets: ${error}`);
      }
    },
    [loadSkus]
  );

  const loadProductLines = useCallback(async () => {
    try {
      const response = await fetch("/api/inventory/product-lines");
      if (!response.ok) throw new Error("Failed to load product lines");
      const productLines = await response.json();

      setState((prev) => ({ ...prev, productLines }));

      // Auto-select Pokemon (product line 3) and load its sets
      loadSets(3);
    } catch (error) {
      baseProcessor.setError(`Failed to load product lines: ${error}`);
    }
  }, [loadSets]);

  const loadCurrentInventory = useCallback(async () => {
    try {
      const response = await fetch("/api/inventory/current");
      if (!response.ok) throw new Error("Failed to load current inventory");
      const currentInventory = await response.json();
      setState((prev) => ({ ...prev, currentInventory }));
    } catch (error) {
      baseProcessor.setError(`Failed to load current inventory: ${error}`);
    }
  }, []); // Remove setError dependency

  const loadPendingInventory = useCallback(async () => {
    try {
      const response = await fetch("/api/pending-inventory");
      if (!response.ok) throw new Error("Failed to load pending inventory");
      const pendingInventory = await response.json();
      setState((prev) => ({ ...prev, pendingInventory }));
    } catch (error) {
      baseProcessor.setError(`Failed to load pending inventory: ${error}`);
    }
  }, []);

  const sendPendingMutation = useCallback(
    async (body: Record<string, unknown>) => {
      const send = () =>
        fetch("/api/pending-inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      let response: Response;
      try {
        response = await send();
      } catch {
        response = await send();
      }
      const payload = (await response.json()) as {
        quantity?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update pending inventory");
      }
      return payload;
    },
    [],
  );

  const queuePendingMutation = useCallback(
    <T,>(work: () => Promise<T>): Promise<T> => {
      inventoryMutationState.current.started();
      const run = async () => {
        try {
          return await work();
        } finally {
          if (inventoryMutationState.current.finished()) {
            await loadPendingInventory();
          }
        }
      };
      const queued = inventoryMutationQueue.current.then(run, run);
      inventoryMutationQueue.current = queued.catch(() => undefined);
      return queued;
    },
    [loadPendingInventory],
  );

  const updateLocalPendingQuantity = useCallback(
    (
      sku: number,
      quantity: number,
      metadata: { productLineId: number; setId: number; productId: number },
    ) => {
      setState((prev) => {
        const existing = prev.pendingInventory.find((entry) => entry.sku === sku);
        const withoutSku = prev.pendingInventory.filter((entry) => entry.sku !== sku);
        if (quantity <= 0) {
          return { ...prev, pendingInventory: withoutSku };
        }
        const now = new Date();
        return {
          ...prev,
          pendingInventory: [
            ...withoutSku,
            {
              sku,
              quantity,
              ...metadata,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            },
          ],
        };
      });
    },
    [],
  );

  const adjustPendingInventory = useCallback(
    async (
      sku: number,
      quantityDelta: number,
      metadata: { productLineId: number; setId: number; productId: number }
    ) => {
      if (quantityDelta === 0) return;
      const requestId = crypto.randomUUID();
      const mutationToken = inventoryMutationState.current.beginSku(sku);
      setState((prev) => {
        const current = prev.pendingInventory.find((entry) => entry.sku === sku)?.quantity ?? 0;
        const next = Math.max(0, current + quantityDelta);
        const existing = prev.pendingInventory.find((entry) => entry.sku === sku);
        const withoutSku = prev.pendingInventory.filter((entry) => entry.sku !== sku);
        if (next === 0) return { ...prev, pendingInventory: withoutSku };
        const now = new Date();
        return {
          ...prev,
          pendingInventory: [...withoutSku, {
            sku, quantity: next, ...metadata,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
          }],
        };
      });

      void queuePendingMutation(async () => {
        try {
          const payload = await sendPendingMutation({
            operation: quantityDelta > 0 ? "add" : "remove",
            requestId,
            sku,
            quantity: Math.abs(quantityDelta),
            ...metadata,
          });
          if (inventoryMutationState.current.canApplySku(mutationToken)) {
            updateLocalPendingQuantity(sku, payload.quantity ?? 0, metadata);
          }
        } catch (error) {
          baseProcessor.setError(`Failed to update pending inventory: ${error}`);
          inventoryMutationState.current.failed();
        }
      });
    },
    [loadPendingInventory, queuePendingMutation, sendPendingMutation, updateLocalPendingQuantity],
  );

  const setPendingInventory = useCallback(
    (
      sku: number,
      quantity: number,
      expectedQuantity: number,
      metadata: { productLineId: number; setId: number; productId: number },
    ) => {
      const requestId = crypto.randomUUID();
      const mutationToken = inventoryMutationState.current.beginSku(sku);
      updateLocalPendingQuantity(sku, quantity, metadata);
      void queuePendingMutation(async () => {
        try {
          const payload = await sendPendingMutation({
            operation: "set",
            requestId,
            sku,
            quantity,
            expectedQuantity,
            ...metadata,
          });
          if (inventoryMutationState.current.canApplySku(mutationToken)) {
            updateLocalPendingQuantity(sku, payload.quantity ?? 0, metadata);
          }
        } catch (error) {
          baseProcessor.setError(`Failed to update pending inventory: ${error}`);
          inventoryMutationState.current.failed();
        }
      });
    },
    [loadPendingInventory, queuePendingMutation, sendPendingMutation, updateLocalPendingQuantity],
  );

  const clearPendingInventory = useCallback(() => {
    const requestId = crypto.randomUUID();
    inventoryMutationState.current.beginBarrier();
    setState((prev) => ({ ...prev, pendingInventory: [] }));
    void queuePendingMutation(async () => {
      try {
        await sendPendingMutation({ operation: "clear", requestId });
      } catch (error) {
        baseProcessor.setError(`Failed to clear pending inventory: ${error}`);
        inventoryMutationState.current.failed();
      }
    });
  }, [loadPendingInventory, queuePendingMutation, sendPendingMutation]);
  const createBatchFromPendingInventory = useCallback((purchaseCost?: PurchaseCostAtIntake) => {
    const requestId = pendingBatchRequestId.current ?? crypto.randomUUID();
    pendingBatchRequestId.current = requestId;
    const barrierVersion = inventoryMutationState.current.beginBarrier();
    return queuePendingMutation(async () => {
      baseProcessor.setError(null);
      try {
        const batch = await createPendingInventoryBatch(requestId, purchaseCost);
        pendingBatchRequestId.current = null;
        if (inventoryMutationState.current.canApplyBarrier(barrierVersion)) {
          await loadPendingInventory();
        }
        return batch;
      } catch (error) {
        if (
          error instanceof PendingBatchRequestError &&
          error.outcome === "definitive"
        ) {
          pendingBatchRequestId.current = null;
        }
        baseProcessor.setError(
          `${error instanceof Error ? error.message : String(error)}. ` +
            "Select Process & Price again to safely recover or retry this batch.",
        );
        throw error;
      }
    });
  }, [loadPendingInventory, queuePendingMutation]);

  const toggleSealedFilter = useCallback(
    (sealedFilter: "all" | "sealed" | "unsealed") => {
      setState((prev) => ({ ...prev, sealedFilter }));
    },
    []
  );

  const setSelectedLanguages = useCallback((languages: string[]) => {
    setState((prev) => ({ ...prev, selectedLanguages: languages }));
  }, []);

  const setSelectedCondition = useCallback(
    (condition: InventorySelectableCondition) => {
      setState((prev) => ({ ...prev, selectedCondition: condition }));
    },
    []
  );

  const selectPreviousCondition = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selectedCondition: getPreviousInventoryCondition(prev.selectedCondition),
    }));
  }, []);

  const selectNextCondition = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selectedCondition: getNextInventoryCondition(prev.selectedCondition),
    }));
  }, []);

  const getFilteredSkus = useCallback((): SkuWithDisplayInfo[] => {
    let filtered = state.skus;

    // Apply sealed filter
    if (state.sealedFilter === "sealed") {
      filtered = filtered.filter((sku) => sku.sealed);
    } else if (state.sealedFilter === "unsealed") {
      filtered = filtered.filter((sku) => !sku.sealed);
    }

    // Apply language filter
    if (state.selectedLanguages.length > 0) {
      filtered = filtered.filter((sku) =>
        state.selectedLanguages.includes(sku.language)
      );
    }

    return filtered;
  }, [state.skus, state.sealedFilter, state.selectedLanguages]);

  const getAvailableLanguages = useCallback((): string[] => {
    const languages = new Set<string>();
    state.skus.forEach((sku) => {
      if (sku.language) {
        languages.add(sku.language);
      }
    });
    return Array.from(languages).sort();
  }, [state.skus]);

  return {
    // Ensure arrays are always defined
    productLines: state.productLines || [],
    sets: state.sets || [],
    skus: state.skus || [],
    currentInventory: state.currentInventory || [],
    pendingInventory: state.pendingInventory || [],
    selectedProductLineId: state.selectedProductLineId,
    selectedSetId: state.selectedSetId,
    searchScope: state.searchScope,
    allSetsSearchTerm: state.allSetsSearchTerm,
    sealedFilter: state.sealedFilter,
    selectedLanguages: state.selectedLanguages || [],
    selectedCondition: state.selectedCondition,
    ...baseProcessor,
    setError: baseProcessor.setError,
    setWarning: baseProcessor.setWarning,
    setSuccess: baseProcessor.setSuccess,
    loadProductLines,
    loadSets,
    loadSkus,
    loadSkusByCardNumber,
    selectSet,
    setSearchScope,
    loadCurrentInventory,
    loadPendingInventory,
    adjustPendingInventory,
    setPendingInventory,
    clearPendingInventory,
    createBatchFromPendingInventory,
    toggleSealedFilter,
    setSelectedLanguages,
    setSelectedCondition,
    selectPreviousCondition,
    selectNextCondition,
    getFilteredSkus,
    getAvailableLanguages,
  };
};
