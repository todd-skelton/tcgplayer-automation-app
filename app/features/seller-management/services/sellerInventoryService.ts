import type { SellerInventoryItem } from "../../inventory-management/services/inventoryConverter";

export interface SellerInventoryConfig {
  sellerKey: string;
  onProgress?: (current: number, total: number, status: string) => void;
  isCancelled?: () => boolean;
}

export interface SellerInventoryResponse {
  inventory: SellerInventoryItem[];
  totalProducts: number;
  sellerKey: string;
  error?: string;
}

export class SellerInventoryService {
  async fetchSellerInventory(
    config: SellerInventoryConfig
  ): Promise<SellerInventoryItem[]> {
    const { sellerKey, onProgress, isCancelled } = config;

    onProgress?.(0, 1, "Fetching seller inventory...");

    try {
      const response = await fetch("/api/seller-inventory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sellerKey }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: SellerInventoryResponse = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      if (isCancelled?.()) {
        throw new Error("Operation cancelled");
      }

      onProgress?.(1, 1, `Found ${data.totalProducts} products for seller`);

      return data.inventory;
    } catch (error: any) {
      if (error.message === "Operation cancelled") {
        throw error;
      }
      throw new Error(`Failed to fetch seller inventory: ${error.message}`);
    }
  }
}
