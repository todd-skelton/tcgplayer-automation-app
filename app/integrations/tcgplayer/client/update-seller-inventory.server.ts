import { sellerPortal } from "~/core/clients";

const UPDATE_INVENTORY_PATH = "/admin/product/updateinventory";
const FORM_ITEM_PREFIX = "productQuantityPrices[0]";
const FORM_CONDITION_PREFIX = `${FORM_ITEM_PREFIX}[ConditionQuantityPrices][0]`;

export interface UpdateSellerInventoryRequest {
  productId: number;
  /** TCGplayer's ProductConditionId, used as the inventory SKU. */
  sku: number;
  /** Authoritative quantity to leave in stock after the update. */
  absoluteQuantity: number;
  price: number;
}

interface UpdateSellerInventoryResponse {
  success: boolean;
}

type PostSellerInventoryUpdate = (
  form: URLSearchParams,
) => Promise<UpdateSellerInventoryResponse>;

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}

function requirePrice(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("price must be a non-negative finite number.");
  }
}

/**
 * Builds the smallest verified Seller Portal payload.
 *
 * Quantity is deliberately required. The endpoint treats an omitted Quantity
 * as zero, so allowing a price-only payload could remove available stock.
 */
export function buildSellerInventoryUpdateForm(
  request: UpdateSellerInventoryRequest,
): URLSearchParams {
  requirePositiveInteger(request.productId, "productId");
  requirePositiveInteger(request.sku, "sku");
  requireNonNegativeInteger(request.absoluteQuantity, "absoluteQuantity");
  requirePrice(request.price);

  return new URLSearchParams([
    [`${FORM_ITEM_PREFIX}[ProductId]`, String(request.productId)],
    [`${FORM_CONDITION_PREFIX}[ProductConditionId]`, String(request.sku)],
    [`${FORM_CONDITION_PREFIX}[Quantity]`, String(request.absoluteQuantity)],
    [`${FORM_CONDITION_PREFIX}[Price]`, request.price.toFixed(2)],
  ]);
}

async function postSellerInventoryUpdate(
  form: URLSearchParams,
): Promise<UpdateSellerInventoryResponse> {
  return sellerPortal.post<UpdateSellerInventoryResponse, URLSearchParams>(
    UPDATE_INVENTORY_PATH,
    form,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
    },
  );
}

/**
 * Sets the current price and absolute quantity for one seller inventory SKU.
 *
 * Supplying an absolute quantity makes a repeated successful request
 * idempotent. Callers should still serialize updates for the same SKU because
 * the Seller Portal rejects immediate duplicate submissions while an update is
 * still being applied.
 */
export async function updateSellerInventory(
  request: UpdateSellerInventoryRequest,
  postUpdate: PostSellerInventoryUpdate = postSellerInventoryUpdate,
): Promise<void> {
  const response = await postUpdate(buildSellerInventoryUpdateForm(request));

  if (!response.success) {
    throw new Error(
      `TCGplayer did not confirm the inventory update for SKU ${request.sku}.`,
    );
  }
}
