export type PendingInventoryEntry = {
  id?: string; // NeDB auto-generated ID
  sku: number;
  quantity: number;
  productLineId: number; // Required for performance optimization
  setId: number; // Required for performance optimization
  productId: number; // Required for performance optimization
  createdAt: Date;
  updatedAt: Date;
};
