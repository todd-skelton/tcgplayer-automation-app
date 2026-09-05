import { createProviderRequest } from "../connections/providerRequest.server";
import { providerRequestGate } from "../connections/providerConnections.server";
import { createAltEvidenceProvider } from "./altEvidenceProvider.server";

export function createAltEvidenceForRun(signal?: AbortSignal) {
  return createAltEvidenceProvider(createProviderRequest(providerRequestGate), {
    signal,
  });
}
