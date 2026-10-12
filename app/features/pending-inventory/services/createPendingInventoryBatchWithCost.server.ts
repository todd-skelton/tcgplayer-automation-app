import { inventoryBatchesRepository, inventoryEconomicsRepository } from "~/core/db";
import { withTransaction, type Queryable } from "~/core/db/database.server";
import type { EstimatedCostRate } from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import type { NormalizedPurchaseCostDetails } from "~/features/inventory-economics/domain/purchaseCostDetails";
import { recordEstimatedPurchaseCosts } from "~/features/inventory-economics/services/estimatedPurchaseCosts.server";
import type { InventoryBatch } from "../types/inventoryBatch";

interface PendingBatchWithCostDependencies {
  transaction: <T>(work:(executor:Queryable)=>Promise<T>)=>Promise<T>;
  createBatch:(requestId:string,executor?:Queryable,estimatedCostRate?:EstimatedCostRate)=>Promise<InventoryBatch | null>;
  recordPurchaseCost:typeof inventoryEconomicsRepository.recordPurchaseCost;
  recordEstimatedPurchaseCosts:typeof recordEstimatedPurchaseCosts;
}

/** How a new batch is costed: an entered purchase total, or an estimate for the seller, optionally at an overriding rate. */
export interface PendingBatchCost {
  purchaseCost?:NormalizedPurchaseCostDetails;
  estimateForSeller:string | null;
  estimatedCostRate?:EstimatedCostRate;
}

const defaultDependencies: PendingBatchWithCostDependencies = {
  transaction:withTransaction,
  createBatch:inventoryBatchesRepository.createFromPendingInventory,
  recordPurchaseCost:inventoryEconomicsRepository.recordPurchaseCost,
  recordEstimatedPurchaseCosts,
};

/**
 * Creates the batch and records its purchase cost in one transaction: the
 * entered cost when one was supplied, otherwise the estimated cost for the
 * configured seller at the batch's cost rate. Without a seller the batch is
 * created without cost.
 */
export async function createPendingInventoryBatchWithCost(
  requestId:string,
  cost:PendingBatchCost,
  dependencies:PendingBatchWithCostDependencies=defaultDependencies,
  executor?:Queryable,
):Promise<InventoryBatch | null> {
  if (cost.purchaseCost && cost.estimatedCostRate) {
    throw new Error("Enter a purchase total or a cost rate, not both.");
  }
  if (cost.estimatedCostRate && !cost.estimateForSeller) {
    throw new Error("A cost rate needs a seller to record the estimated cost for.");
  }
  const perform = async (executor:Queryable)=>{
    const batch = await dependencies.createBatch(requestId,executor,cost.estimatedCostRate);
    if (!batch) return batch;
    if (cost.purchaseCost) {
      await dependencies.recordPurchaseCost({
        ...cost.purchaseCost,
        batchNumbers:[batch.batchNumber],
      },executor);
    } else if (cost.estimateForSeller) {
      await dependencies.recordEstimatedPurchaseCosts(
        cost.estimateForSeller,{ batchNumbers:[batch.batchNumber] },undefined,executor);
    }
    return batch;
  };
  return executor ? perform(executor) : dependencies.transaction(perform);
}
