export type PendingInventoryEntry = {
  id?: string; // Optional legacy identifier
  sku: number;
  quantity: number;
  productLineId: number; // Required for performance optimization
  setId: number; // Required for performance optimization
  productId: number; // Required for performance optimization
  createdAt: Date;
  updatedAt: Date;
};
