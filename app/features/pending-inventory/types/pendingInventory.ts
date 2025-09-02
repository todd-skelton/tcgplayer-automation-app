export type PendingInventoryEntry = {
  id?: string; // NeDB auto-generated ID
  sku: number;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
};
