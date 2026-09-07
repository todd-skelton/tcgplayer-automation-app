import { randomUUID } from "node:crypto";
import { inventoryOpeningBalancesRepository } from "~/core/db";
import { synchronizeSellerOrders } from "~/features/seller-order-history/services/synchronizeSellerOrders.server";
import { captureInventoryObservation } from "./captureInventoryObservation.server";

type Dependencies = {
  capture: typeof captureInventoryObservation;
  findReplay: typeof inventoryOpeningBalancesRepository.findApplicationReplay;
  synchronizeOrders: typeof synchronizeSellerOrders;
  apply: typeof inventoryOpeningBalancesRepository.apply;
};

export async function applyInventoryOpeningBalance(
  input: { requestId: string; runId: string; evidenceFingerprint: string; sellerKey: string },
  overrides: Partial<Dependencies> = {},
) {
  const dependencies: Dependencies = {
    capture: captureInventoryObservation,
    findReplay: (value) => inventoryOpeningBalancesRepository.findApplicationReplay(value),
    synchronizeOrders: synchronizeSellerOrders,
    apply: (value) => inventoryOpeningBalancesRepository.apply(value),
    ...overrides,
  };
  const requestId=input.requestId.trim();
  if(!requestId) throw new Error("Application request ID is required.");
  const replay=await dependencies.findReplay({
    runId:input.runId,sellerKey:input.sellerKey,requestId,
    expectedFingerprint:input.evidenceFingerprint,
  });
  if(replay) return replay;
  const observation=await dependencies.capture({
    requestId:`${requestId}:inventory-revalidation:${randomUUID()}`,
    sellerKey:input.sellerKey,
    purposeEvidence:{
      kind:"opening_apply",applicationRequestId:requestId,runId:input.runId,
      evidenceFingerprint:input.evidenceFingerprint,
    },
  });
  if(observation.status!=="complete") {
    throw new Error("Current seller inventory could not be observed consistently.");
  }
  await dependencies.synchronizeOrders(input.sellerKey,{maxPages:4,maxDetails:25,pageSize:500,detailConcurrency:5});
  try {
    return await dependencies.apply({
      runId:input.runId,
      expectedFingerprint:input.evidenceFingerprint,
      sellerKey:input.sellerKey,
      requestId,
      validationObservationId:observation.id,
    });
  } catch(error) {
    throw new Error(`${String(error)} Current inventory evidence is observation ${observation.id}.`);
  }
}
