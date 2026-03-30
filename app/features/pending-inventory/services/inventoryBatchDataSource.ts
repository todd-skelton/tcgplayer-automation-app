import type { PricerSku } from "~/core/types/pricing";
import type { DataSourceService } from "~/shared/services/dataSourceInterfaces";
import type { InventoryBatchItem } from "../types/inventoryBatch";

export class InventoryBatchDataSource
  implements DataSourceService<InventoryBatchItem>
{
  private batchNumber: number | null = null;
  private errorsOnly = false;

  setContext(batchNumber: number, errorsOnly: boolean): void {
    this.batchNumber = batchNumber;
    this.errorsOnly = errorsOnly;
  }

  async fetchData(): Promise<InventoryBatchItem[]> {
    if (!this.batchNumber) {
      throw new Error("No batch selected");
    }

    const scopeQuery = this.errorsOnly ? "?scope=errors" : "";
    const response = await fetch(
      `/api/inventory-batches/${this.batchNumber}/items${scopeQuery}`,
    );

    if (!response.ok) {
      throw new Error("Failed to load inventory batch items");
    }

    return await response.json();
  }

  async validateData(items: InventoryBatchItem[]): Promise<InventoryBatchItem[]> {
    return items.filter(
      (item) =>
        item.sku &&
        item.sku > 0 &&
        item.totalQuantity + item.addToQuantity > 0,
    );
  }

  async convertToPricerSku(items: InventoryBatchItem[]): Promise<PricerSku[]> {
    return items.map((item) => ({
      sku: item.sku,
      quantity: item.totalQuantity > 0 ? item.totalQuantity : undefined,
      addToQuantity: item.addToQuantity > 0 ? item.addToQuantity : undefined,
      currentPrice: item.currentPrice ?? undefined,
      productLineId: item.productLineId,
      setId: item.setId,
      productId: item.productId,
    }));
  }
}
