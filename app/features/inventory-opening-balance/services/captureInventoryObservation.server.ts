import { inventoryOpeningBalancesRepository } from "~/core/db";
import {
  exportLiveSellerInventory,
  getSellerPricingContext,
} from "~/integrations/tcgplayer/client/export-live-inventory.server";
import {
  contentFingerprint,
  parseCompleteInventoryExport,
  quantityFingerprint,
  supportedQuantityFingerprint,
} from "../domain/inventoryObservation";
import { validateSellerPricingContext } from "../domain/inventoryObservation";

type Dependencies = {
  begin: typeof inventoryOpeningBalancesRepository.beginObservationCapture;
  getContext: typeof getSellerPricingContext;
  exportInventory: typeof exportLiveSellerInventory;
  now: () => Date;
  record: typeof inventoryOpeningBalancesRepository.recordObservation;
  fail: typeof inventoryOpeningBalancesRepository.failObservationCapture;
};

export async function captureInventoryObservation(
  input: { requestId: string; sellerKey: string; purposeEvidence?: Record<string,unknown> },
  overrides: Partial<Dependencies> = {},
) {
  const dependencies: Dependencies = {
    begin: (value) => inventoryOpeningBalancesRepository.beginObservationCapture(value),
    getContext: getSellerPricingContext,
    exportInventory: exportLiveSellerInventory,
    now: () => new Date(),
    record: (value) => inventoryOpeningBalancesRepository.recordObservation(value),
    fail: (requestId,claimToken,error) => inventoryOpeningBalancesRepository.failObservationCapture(requestId,claimToken,error),
    ...overrides,
  };
  const sellerKey = input.sellerKey.trim();
  if (!input.requestId.trim() || !sellerKey) throw new Error("Request ID and seller key are required.");
  const requestId=input.requestId.trim();
  const claim=await dependencies.begin({requestId,sellerKey,...(input.purposeEvidence?{purposeEvidence:input.purposeEvidence}:{})});
  if (claim.state === "complete") return claim.observation;
  const abortController=new AbortController();
  const deadline=setTimeout(()=>abortController.abort(),150_000);
  try {
    const startedAt = dependencies.now();
    const beforeContext = await dependencies.getContext({signal:abortController.signal});
    const beforeIdentityDeclarationCount=validateSellerPricingContext(beforeContext, sellerKey);
    const firstCsv = await dependencies.exportInventory({signal:abortController.signal});
    const firstItems = parseCompleteInventoryExport(firstCsv);
    const secondCsv = await dependencies.exportInventory({signal:abortController.signal});
    const secondItems = parseCompleteInventoryExport(secondCsv);
    const afterContext = await dependencies.getContext({signal:abortController.signal});
    const afterIdentityDeclarationCount=validateSellerPricingContext(afterContext, sellerKey);
    const firstQuantityFingerprint = quantityFingerprint(firstItems);
    const secondQuantityFingerprint = quantityFingerprint(secondItems);
    const stable = firstQuantityFingerprint === secondQuantityFingerprint;
    return await dependencies.record({
      requestId, sellerKey, claimToken: claim.claimToken,
      beforeIdentityDeclarationCount, afterIdentityDeclarationCount,
      status: stable ? "complete" : "unstable",
      startedAt, cutoffAt: dependencies.now(),
      quantityFingerprint: secondQuantityFingerprint,
      supportedQuantityFingerprint:supportedQuantityFingerprint(secondItems),
      firstContentFingerprint: contentFingerprint(firstCsv),
      secondContentFingerprint: contentFingerprint(secondCsv),
      items: secondItems,
      ...(!stable ? { error: "Seller quantities changed between complete exports." } : {}),
    });
  } catch (error) {
    await dependencies.fail(requestId,claim.claimToken,String(error));
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
