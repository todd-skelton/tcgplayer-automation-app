import { createProviderRequest } from "../connections/providerRequest.server";
import { providerRequestGate } from "../connections/providerConnections.server";
import { createAltEvidenceProvider } from "./altEvidenceProvider.server";
import { createEbayResearchProvider } from "./ebayResearchProvider.server";

export function createAltEvidenceForRun(signal?: AbortSignal) {
  return createAltEvidenceProvider(createProviderRequest(providerRequestGate), {
    signal,
  });
}

export function createEbayResearchForRun(signal?: AbortSignal) {
  return createEbayResearchProvider(
    createProviderRequest(providerRequestGate),
    { signal },
  );
}
