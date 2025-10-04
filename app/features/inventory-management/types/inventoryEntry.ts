export type InventoryEntry = {
  id?: string; // NeDB auto-generated ID
  sku: number;
  productId: number;
  productName: string;
  setName: string;
  productLineName: string;
  condition: string;
  variant: string;
  language: string;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
};

export type InventoryFilter = {
  productLineId?: number;
  setNameId?: number;
  productId?: number;
  condition?: string;
  variant?: string;
  language?: string;
  languages?: string[]; // Support multiple language filtering
};

export type InventoryFormData = {
  productLineId: number;
  setNameId: number;
  selectedProducts: {
    productId: number;
    skus: {
      sku: number;
      quantity: number;
    }[];
  }[];
};
