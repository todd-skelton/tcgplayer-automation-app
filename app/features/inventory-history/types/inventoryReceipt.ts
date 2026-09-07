export type InventoryMarketObservation = {
  marketValue: number | null;
  observedAt: Date | null;
  calculatedAt: Date | null;
  provenance: "tcgplayer_price_points" | "tcgplayer_price_points_unavailable";
};

export type InventoryReceipt = {
  receiptId: number;
  requestId: string;
  sku: number;
  originalQuantity: number;
  productLineId: number;
  setId: number;
  productId: number;
  sellerKey: string | null;
  intakeAt: Date | null;
  recordedAt: Date;
  marketValue: number | null;
  marketObservedAt: Date | null;
  marketCalculatedAt: Date | null;
  marketProvenance: string;
  sourceEvidence: Record<string, unknown> | null;
};

export type PendingInventoryMetadata = {
  productLineId: number;
  setId: number;
  productId: number;
};

type PendingMutationIdentity = {
  requestId: string;
  sku: number;
  metadata: PendingInventoryMetadata;
};

export type AddPendingInventory = PendingMutationIdentity & {
  type: "add";
  quantity: number;
  intakeAt: Date;
  market: InventoryMarketObservation;
};

export type RemovePendingInventory = PendingMutationIdentity & {
  type: "remove";
  quantity: number;
};

export type SetPendingInventory = PendingMutationIdentity & {
  type: "set";
  quantity: number;
  expectedQuantity: number;
  intakeAt: Date;
  market: InventoryMarketObservation;
};

export type ClearPendingInventory = {
  type: "clear";
  requestId: string;
};

export type PendingInventoryMutation =
  | AddPendingInventory
  | RemovePendingInventory
  | SetPendingInventory
  | ClearPendingInventory;

export type PendingInventoryMutationResult = {
  requestId: string;
  quantity: number;
  quantityDelta: number;
  repeated: boolean;
};
