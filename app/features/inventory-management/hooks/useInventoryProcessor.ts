import { useState, useCallback } from "react";
import type { InventoryEntry, InventoryFilter } from "../types/inventoryEntry";
import type { PendingInventoryEntry } from "../../pending-inventory/types/pendingInventory";
import type { ProductLine } from "../../../shared/data-types/productLine";
import type { CategorySet } from "../../../shared/data-types/categorySet";
import type { Sku } from "../../../shared/data-types/sku";
import type { TcgPlayerListing, PricerSku } from "../../../core/types/pricing";
import { useProcessorBase } from "../../file-upload/hooks/useProcessorBase";
import { downloadCSV } from "../../../core/utils/csvProcessing";
import { PricingCalculator } from "../../pricing/services/pricingCalculator";
import { DataEnrichmentService } from "../../../shared/services/dataEnrichmentService";
import { PricedSkuToTcgPlayerListingConverter } from "../../file-upload/services/dataConverters";

// Extended interface for SKUs with display information
interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
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
  sealedFilter: "all" | "sealed" | "unsealed";
  selectedLanguages: string[];
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
  loadSkus: (setId: number) => Promise<void>;
  loadCurrentInventory: () => Promise<void>;
  loadPendingInventory: () => Promise<void>;
  updatePendingInventory: (
    sku: number,
    quantity: number,
    metadata: { productLineId: number; setId: number; productId: number }
  ) => void;
  clearPendingInventory: () => void;
  toggleSealedFilter: (sealedFilter: "all" | "sealed" | "unsealed") => void;
  setSelectedLanguages: (languages: string[]) => void;
  getFilteredSkus: () => SkuWithDisplayInfo[];
  getAvailableLanguages: () => string[];
  processInventory: () => Promise<void>;
}

export const useInventoryProcessor = (): InventoryProcessorReturn => {
  const baseProcessor = useProcessorBase();
  const [state, setState] = useState<InventoryProcessorState>({
    productLines: [],
    sets: [],
    skus: [],
    currentInventory: [],
    pendingInventory: [],
    selectedProductLineId: null,
    selectedSetId: null,
    sealedFilter: "all",
    selectedLanguages: [],
  });

  const loadProductLines = useCallback(async () => {
    try {
      const response = await fetch("/api/inventory/product-lines");
      if (!response.ok) throw new Error("Failed to load product lines");
      const productLines = await response.json();
      setState((prev) => ({ ...prev, productLines }));
    } catch (error) {
      baseProcessor.setError(`Failed to load product lines: ${error}`);
    }
  }, []); // Remove setError dependency

  const loadSets = useCallback(
    async (productLineId: number) => {
      try {
        const response = await fetch(
          `/api/inventory/sets?productLineId=${productLineId}`
        );
        if (!response.ok) throw new Error("Failed to load sets");
        const sets = await response.json();
        setState((prev) => ({
          ...prev,
          sets,
          selectedProductLineId: productLineId,
          selectedSetId: null,
          skus: [],
        }));
      } catch (error) {
        baseProcessor.setError(`Failed to load sets: ${error}`);
      }
    },
    [] // Remove setError dependency
  );

  const loadSkus = useCallback(
    async (setId: number) => {
      try {
        // Load SKUs for the selected set
        // Include productLineId for efficient sharded query
        const skusResponse = await fetch(
          `/api/inventory/skus-by-set?setId=${setId}&productLineId=${state.selectedProductLineId}`
        );

        if (!skusResponse.ok) throw new Error("Failed to load SKUs");

        const skus = await skusResponse.json();

        setState((prev) => ({
          ...prev,
          skus,
          selectedSetId: setId,
        }));
      } catch (error) {
        baseProcessor.setError(`Failed to load SKUs: ${error}`);
      }
    },
    [state.selectedProductLineId] // Add selectedProductLineId as dependency
  );

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

  const updatePendingInventory = useCallback(
    async (
      sku: number,
      quantity: number,
      metadata: { productLineId: number; setId: number; productId: number }
    ) => {
      try {
        const response = await fetch("/api/pending-inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "PUT",
            sku,
            quantity,
            productLineId: metadata.productLineId,
            setId: metadata.setId,
            productId: metadata.productId,
          }),
        });

        if (!response.ok) throw new Error("Failed to update pending inventory");

        // Reload pending inventory to get the latest state
        await loadPendingInventory();
      } catch (error) {
        baseProcessor.setError(`Failed to update pending inventory: ${error}`);
      }
    },
    [loadPendingInventory]
  );

  const clearPendingInventory = useCallback(async () => {
    try {
      const response = await fetch("/api/pending-inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "DELETE" }),
      });

      if (!response.ok) throw new Error("Failed to clear pending inventory");

      // Update local state
      setState((prev) => ({ ...prev, pendingInventory: [] }));
    } catch (error) {
      baseProcessor.setError(`Failed to clear pending inventory: ${error}`);
    }
  }, []);
  const processInventory = useCallback(
    async (percentile: number = 50) => {
      if (state.pendingInventory.length === 0) {
        baseProcessor.setError("No inventory entries to process");
        return;
      }

      baseProcessor.startProcessing();

      try {
        // Convert pending inventory to PricerSku format
        const pricerSkus: PricerSku[] = [];
        const skusNotFoundByProductLine: Map<
          number,
          { skus: number[]; entries: PendingInventoryEntry[] }
        > = new Map();

        for (const pendingEntry of state.pendingInventory) {
          const sku = pendingEntry.sku;
          const quantity = pendingEntry.quantity;

          const skuData = state.skus.find((s) => s.sku === sku);
          if (skuData) {
            pricerSkus.push({
              sku,
              quantity: 0, // Existing quantity (always 0 for new inventory)
              addToQuantity: quantity,
              productLineId: pendingEntry.productLineId,
              setId: pendingEntry.setId,
              productId: pendingEntry.productId,
            });
          } else {
            // SKU data not found in current state, group by product line for efficient fetching
            const productLineId = pendingEntry.productLineId;
            if (!skusNotFoundByProductLine.has(productLineId)) {
              skusNotFoundByProductLine.set(productLineId, {
                skus: [],
                entries: [],
              });
            }
            const group = skusNotFoundByProductLine.get(productLineId)!;
            group.skus.push(sku);
            group.entries.push(pendingEntry);
          }
        }

        // If we have SKUs that aren't in the current state, fetch their data grouped by product line
        if (skusNotFoundByProductLine.size > 0) {
          baseProcessor.setProgress({
            current: 0,
            total: state.pendingInventory.length,
            status: "Fetching SKU data for pending inventory...",
            processed: 0,
            skipped: 0,
            errors: 0,
            warnings: 0,
          });

          try {
            // Create the productLineSkus object structure for the API
            const productLineSkus: { [key: string]: number[] } = {};
            for (const [productLineId, group] of skusNotFoundByProductLine) {
              productLineSkus[productLineId.toString()] = group.skus;
            }

            // Make a single API call with all grouped SKUs
            const skuResponse = await fetch("/api/inventory/skus", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ productLineSkus }),
            });

            if (skuResponse.ok) {
              const skuDataArray = await skuResponse.json();

              // Add PricerSku entries for the fetched SKUs
              for (const skuData of skuDataArray) {
                const pendingEntry = state.pendingInventory.find(
                  (p) => p.sku === skuData.sku
                );
                if (pendingEntry) {
                  pricerSkus.push({
                    sku: skuData.sku,
                    quantity: 0,
                    addToQuantity: pendingEntry.quantity,
                    productLineId: pendingEntry.productLineId,
                    setId: pendingEntry.setId,
                    productId: pendingEntry.productId,
                  });
                }
              }
            } else {
              console.warn("Failed to fetch missing SKU data");
            }
          } catch (error) {
            console.warn("Error fetching missing SKU data:", error);
          }
        }

        if (pricerSkus.length === 0) {
          throw new Error(
            "No valid pricing entries could be created from pending inventory"
          );
        }

        // Use the new modular pricing architecture
        const pricingCalculator = new PricingCalculator();
        const enrichmentService = new DataEnrichmentService();

        // First, calculate prices (fast)
        const pricingResult = await pricingCalculator.calculatePrices(
          pricerSkus,
          {
            percentile,
            enableSupplyAnalysis:
              baseProcessor.supplyAnalysisConfig.enableSupplyAnalysis,
            supplyAnalysisConfig: {
              maxListingsPerSku:
                baseProcessor.supplyAnalysisConfig.maxListingsPerSku,
              includeUnverifiedSellers:
                baseProcessor.supplyAnalysisConfig.includeUnverifiedSellers,
            },
            onProgress: (progress: any) => {
              baseProcessor.setProgress(progress);
            },
          }
        );

        // Then enrich with product details for display
        const enrichedSkus = await enrichmentService.enrichForDisplay(
          pricingResult.pricedItems,
          (current: number, total: number, status: string) => {
            baseProcessor.setProgress({
              current,
              total,
              status,
              processed: pricingResult.stats.processed,
              skipped: pricingResult.stats.skipped,
              errors: pricingResult.stats.errors,
              warnings: pricingResult.stats.warnings || 0,
            });
          }
        );

        // Convert to TcgPlayerListing format using the converter
        const converter = new PricedSkuToTcgPlayerListingConverter();
        const processedListings = converter.convertFromPricedSkus(enrichedSkus);

        // Create summary from pricing stats
        const summary = {
          totalRows: pricerSkus.length,
          processedRows: pricingResult.stats.processed,
          skippedRows: pricingResult.stats.skipped,
          errorRows: pricingResult.stats.errors,
          warningRows: pricingResult.stats.warnings || 0,
          successRate:
            (pricingResult.stats.processed / pricerSkus.length) * 100,
          processingTime: pricingResult.stats.processingTime,
          fileName: `inventory-${Date.now()}.csv`,
          percentileUsed: percentile,
          totalQuantity: 0,
          totalAddQuantity: 0,
          totals: {
            marketPrice: 0,
            lowPrice: 0,
            marketplacePrice: 0,
            percentiles: {},
          },
          totalsWithMarket: {
            marketPrice: 0,
            percentiles: {},
            quantityWithMarket: 0,
          },
          medianDaysToSell: {
            historicalSalesVelocity: 0,
            estimatedTimeToSell: 0,
            percentiles: {} as { [key: string]: number },
          },
        };

        // Set the summary
        baseProcessor.setSummary(summary);

        // Clear pending inventory using the API
        await clearPendingInventory();

        // Download the CSV
        const filename = `inventory-${Date.now()}.csv`;
        downloadCSV(processedListings, filename);

        // Show success message
        baseProcessor.setSuccess(
          `Successfully processed ${pricerSkus.length} inventory entries and downloaded CSV. Pending inventory has been cleared.`
        );
      } catch (error: any) {
        if (error?.message === "Processing cancelled by user") {
          console.log("Processing cancelled by user");
          return;
        }
        baseProcessor.setError(
          `Failed to process inventory: ${error?.message || error}`
        );
      } finally {
        baseProcessor.finishProcessing();
      }
    },
    [state.pendingInventory, state.skus, baseProcessor, clearPendingInventory]
  );

  const toggleSealedFilter = useCallback(
    (sealedFilter: "all" | "sealed" | "unsealed") => {
      setState((prev) => ({ ...prev, sealedFilter }));
    },
    []
  );

  const setSelectedLanguages = useCallback((languages: string[]) => {
    setState((prev) => ({ ...prev, selectedLanguages: languages }));
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
    sealedFilter: state.sealedFilter,
    selectedLanguages: state.selectedLanguages || [],
    ...baseProcessor,
    setError: baseProcessor.setError,
    setWarning: baseProcessor.setWarning,
    setSuccess: baseProcessor.setSuccess,
    loadProductLines,
    loadSets,
    loadSkus,
    loadCurrentInventory,
    loadPendingInventory,
    updatePendingInventory,
    clearPendingInventory,
    toggleSealedFilter,
    setSelectedLanguages,
    getFilteredSkus,
    getAvailableLanguages,
    processInventory,
  };
};
