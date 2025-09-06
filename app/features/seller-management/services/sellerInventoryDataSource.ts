import type { PricerSku } from "../../../core/types/pricing";
import type {
  DataSourceService,
  DataSourceConfig,
} from "../../../shared/services/dataSourceInterfaces";
import type { SellerInventoryItem } from "../../inventory-management/services/inventoryConverter";
import { SellerInventoryService } from "./sellerInventoryService";
import { SellerInventoryToPricerSkuConverter } from "../../file-upload/services/dataConverters";

export interface SellerInventoryDataSourceParams {
  sellerKey: string;
}

/**
 * Data source for seller inventory from TCGPlayer API
 */
export class SellerInventoryDataSource
  implements DataSourceService<SellerInventoryItem>
{
  public inventoryService = new SellerInventoryService();
  private converter = new SellerInventoryToPricerSkuConverter();
  private cachedInventory: SellerInventoryItem[] | null = null;
  private cachedSellerKey: string | null = null;

  async fetchData(
    params: SellerInventoryDataSourceParams
  ): Promise<SellerInventoryItem[]> {
    // Return cached data if available and for the same seller
    if (this.cachedInventory && this.cachedSellerKey === params.sellerKey) {
      return this.cachedInventory;
    }

    // Fetch new data and cache it
    const inventory = await this.inventoryService.fetchSellerInventory({
      sellerKey: params.sellerKey,
      onProgress: () => {}, // Will be handled by the pipeline
      isCancelled: () => false, // Will be handled by the pipeline
    });

    this.cachedInventory = inventory;
    this.cachedSellerKey = params.sellerKey;
    return inventory;
  }

  async validateData(
    inventory: SellerInventoryItem[]
  ): Promise<SellerInventoryItem[]> {
    // Seller inventory is already validated by the service
    return inventory;
  }

  async convertToPricerSku(
    inventory: SellerInventoryItem[]
  ): Promise<PricerSku[]> {
    return await this.converter.convertToPricerSkus(inventory);
  }

  /**
   * Validates that all SKUs exist in the database and updates missing products.
   */
  async validateAndUpdateSkus(
    pricerSkus: PricerSku[],
    inventory: SellerInventoryItem[],
    config?: DataSourceConfig
  ): Promise<void> {
    // Extract unique SKU IDs from PricerSku array
    const skuIds = Array.from(
      new Set(
        pricerSkus
          .map((pricerSku) => pricerSku.sku)
          .filter((skuId) => !isNaN(skuId) && skuId > 0)
      )
    );

    if (skuIds.length === 0) {
      return;
    }

    config?.onProgress?.(0, skuIds.length, "Validating SKUs...");

    // Build the structured productLineSkus object required by the new API
    const productLineSkus: Record<string, Record<string, number[]>> = {};

    // Group SKUs by product line and product ID
    for (const pricerSku of pricerSkus) {
      const productLineId = pricerSku.productLineId.toString();
      const productId = pricerSku.productId.toString();

      if (!productLineSkus[productLineId]) {
        productLineSkus[productLineId] = {};
      }

      if (!productLineSkus[productLineId][productId]) {
        productLineSkus[productLineId][productId] = [];
      }

      if (!productLineSkus[productLineId][productId].includes(pricerSku.sku)) {
        productLineSkus[productLineId][productId].push(pricerSku.sku);
      }
    }

    try {
      // Call the server-side API to validate and update SKUs
      const response = await fetch("/api/validate-skus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productLineSkus,
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(result.error);
      }

      // Update progress to complete
      config?.onProgress?.(
        skuIds.length,
        skuIds.length,
        "SKU validation complete"
      );

      console.log(`SKU validation complete: ${result.message}`);
    } catch (error) {
      console.error("Error validating SKUs:", error);
      throw error;
    }
  }

  /**
   * Manually set cached inventory data. Used to avoid refetching when data is already available.
   */
  setCachedInventory(
    inventory: SellerInventoryItem[],
    sellerKey: string
  ): void {
    this.cachedInventory = inventory;
    this.cachedSellerKey = sellerKey;
  }

  /**
   * Clear cached inventory data. Should be called when starting fresh processing.
   */
  clearCache(): void {
    this.cachedInventory = null;
    this.cachedSellerKey = null;
  }
}
