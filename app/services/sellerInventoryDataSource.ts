import type { PricerSku } from "../types/pricing";
import type {
  DataSourceService,
  DataSourceConfig,
} from "./dataSourceInterfaces";
import type { SellerInventoryItem } from "./inventoryConverter";
import { SellerInventoryService } from "./sellerInventoryService";
import { SellerInventoryToPricerSkuConverter } from "./dataConverters";

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

  async fetchData(
    params: SellerInventoryDataSourceParams
  ): Promise<SellerInventoryItem[]> {
    return await this.inventoryService.fetchSellerInventory({
      sellerKey: params.sellerKey,
      onProgress: () => {}, // Will be handled by the pipeline
      isCancelled: () => false, // Will be handled by the pipeline
    });
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
    return this.converter.convertToPricerSkus(inventory);
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

    // Extract product IDs from inventory items
    const productIds = Array.from(
      new Set(inventory.map((item) => item.productId))
    );

    try {
      // Call the server-side API to validate and update SKUs
      const response = await fetch("/api/validate-skus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          skuIds,
          productIds,
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
}
