import {
  continuousPricingRepository,
  pricingConfigRepository,
} from "~/core/db";
import { convertSellerInventoryToBatchItems } from "~/features/file-upload/services/pricingBatchSnapshots.server";
import { fetchSellerInventorySnapshot } from "~/features/seller-management/services/sellerInventorySnapshot.server";

export async function refreshContinuousPricingInventory(
  sellerKey: string,
): Promise<number> {
  const config = await pricingConfigRepository.get();
  const excludeProductLineIds = Object.entries(
    config.productLinePricing.productLineSettings,
  )
    .filter(([, settings]) => settings.skip)
    .map(([productLineId]) => Number(productLineId));
  const snapshot = await fetchSellerInventorySnapshot({
    sellerKey,
    excludeProductLineIds,
  });
  const batchItems = await convertSellerInventoryToBatchItems(
    snapshot.inventory,
  );
  const observedAt = new Date();

  await continuousPricingRepository.upsertSnapshot(
    sellerKey,
    batchItems.map((item) => ({
      sellerKey,
      sku: item.sku,
      productId: item.productId,
      productLineId: item.productLineId,
      setId: item.setId,
      productLine: item.originalRow["Product Line"],
      setName: item.originalRow["Set Name"],
      productName: item.originalRow.Product,
      condition: item.originalRow["Sku Condition"],
      variant: item.originalRow["Sku Variant"],
      quantity: item.totalQuantity,
      currentPrice: item.currentPrice ?? null,
      originalRow: item.originalRow,
    })),
    observedAt,
  );

  return batchItems.length;
}
