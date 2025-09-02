import type { PricerSku } from "../../../core/types/pricing";
import type { DataSourceService } from "../../../shared/services/dataSourceInterfaces";
import type { PendingInventoryEntry } from "../types/pendingInventory";
import { PendingInventoryToPricerSkuConverter } from "../../file-upload/services/dataConverters";

/**
 * Data source for pending inventory stored in the database
 */
export class PendingInventoryDataSource
  implements DataSourceService<PendingInventoryEntry>
{
  private converter = new PendingInventoryToPricerSkuConverter();

  async fetchData(): Promise<PendingInventoryEntry[]> {
    const response = await fetch("/api/pending-inventory");
    if (!response.ok) {
      throw new Error("Failed to load pending inventory");
    }
    return await response.json();
  }

  async validateData(
    inventory: PendingInventoryEntry[]
  ): Promise<PendingInventoryEntry[]> {
    // Filter out invalid entries
    return inventory.filter((item) => {
      return item.sku && item.sku > 0;
    });
  }

  async convertToPricerSku(
    inventory: PendingInventoryEntry[]
  ): Promise<PricerSku[]> {
    return this.converter.convertToPricerSkus(inventory);
  }

  /**
   * Clear all pending inventory
   */
  async clearPendingInventory(): Promise<void> {
    const response = await fetch("/api/pending-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "DELETE" }),
    });

    if (!response.ok) {
      throw new Error("Failed to clear pending inventory");
    }
  }

  /**
   * Get count of pending inventory items
   */
  async getPendingCount(): Promise<number> {
    const inventory = await this.fetchData();
    return inventory.length;
  }
}
