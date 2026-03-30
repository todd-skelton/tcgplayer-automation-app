import type { PricerSku, TcgPlayerListing } from "~/core/types/pricing";
import { productLinesRepository, skusRepository } from "~/core/db";
import {
  convertSellerInventoryToListings,
  type SellerInventoryItem,
} from "~/features/inventory-management/services/inventoryConverter";

export interface BatchSnapshotItem {
  sku: number;
  totalQuantity: number;
  addToQuantity: number;
  currentPrice?: number | null;
  productLineId: number;
  setId: number;
  productId: number;
  originalRow: TcgPlayerListing;
}

function parseInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  return 0;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

async function buildProductLineMap(
  productLineNames: string[],
): Promise<Map<string, number>> {
  const productLineMap = new Map<string, number>();

  for (const productLineName of productLineNames) {
    const productLine = await productLinesRepository.findByNameOrUrlName(
      productLineName,
      productLineName.toLowerCase().replace(/\s+/g, "-"),
    );

    if (productLine) {
      productLineMap.set(productLineName, productLine.productLineId);
    }
  }

  return productLineMap;
}

export async function convertCsvListingsToBatchItems(
  listings: TcgPlayerListing[],
): Promise<BatchSnapshotItem[]> {
  const validListings = listings.filter((listing) => {
    const skuId = Number(listing["TCGplayer Id"]);
    return Number.isFinite(skuId) && skuId > 0;
  });

  const productLineMap = await buildProductLineMap(
    Array.from(
      new Set(
        validListings
          .map((listing) => listing["Product Line"]?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ),
  );

  const snapshots: BatchSnapshotItem[] = [];

  for (const listing of validListings) {
    const skuId = Number(listing["TCGplayer Id"]);
    const productLineName = listing["Product Line"]?.trim();

    if (!productLineName) {
      continue;
    }

    const productLineId = productLineMap.get(productLineName);
    if (!productLineId) {
      continue;
    }

    const skuMetadata = await skusRepository.findBySkuAndProductLine(
      skuId,
      productLineId,
    );

    if (
      !skuMetadata ||
      !skuMetadata.productLineId ||
      !skuMetadata.setId ||
      !skuMetadata.productId
    ) {
      continue;
    }

    snapshots.push({
      sku: skuId,
      totalQuantity: parseInteger(listing["Total Quantity"]),
      addToQuantity: parseInteger(listing["Add to Quantity"]),
      currentPrice: parseNumber(listing["TCG Marketplace Price"]),
      productLineId: skuMetadata.productLineId,
      setId: skuMetadata.setId,
      productId: skuMetadata.productId,
      originalRow: listing,
    });
  }

  return snapshots;
}

export async function convertSellerInventoryToBatchItems(
  inventory: SellerInventoryItem[],
): Promise<BatchSnapshotItem[]> {
  const { listings } = convertSellerInventoryToListings(inventory);
  return convertCsvListingsToBatchItems(listings);
}

export function convertBatchItemsToPricerSkus(
  batchItems: BatchSnapshotItem[],
  options?: { bypassProductLineSkips?: boolean },
): PricerSku[] {
  return batchItems.map((item) => ({
    sku: item.sku,
    quantity: item.totalQuantity > 0 ? item.totalQuantity : undefined,
    addToQuantity: item.addToQuantity > 0 ? item.addToQuantity : undefined,
    currentPrice: item.currentPrice ?? undefined,
    bypassProductLineSkips: options?.bypassProductLineSkips,
    productLineId: item.productLineId,
    setId: item.setId,
    productId: item.productId,
  }));
}
