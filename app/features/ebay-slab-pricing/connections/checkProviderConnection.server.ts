import type { SlabProvider } from "./providerConnection";
import { providerRequestGate } from "./providerConnections.server";
import {
  createProviderRequest,
  ProviderRequestError,
} from "./providerRequest.server";

export const requestSlabProvider = createProviderRequest(providerRequestGate);

export function validateAltConnection(body: string): void {
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new ProviderRequestError("invalid-response");
  }
  if (
    result?.errors?.some?.(
      (error: { extensions?: { code?: string } }) =>
        error?.extensions?.code === "UNAUTHENTICATED",
    ) ||
    result?.data?.me === null
  ) {
    throw new ProviderRequestError("reconnect-required");
  }
  if (
    result?.errors?.length ||
    typeof result?.data?.me?.id !== "string" ||
    !result.data.me.id
  ) {
    throw new ProviderRequestError("invalid-response");
  }
}

export function validateEbayConnection(body: string): void {
  let modules: Array<{ _type?: string; tabs?: Array<{ active?: boolean }> }>;
  try {
    modules = body
      .trim()
      .split(/\r?\n\s*\r?\n/)
      .map((line) => JSON.parse(line));
  } catch {
    throw new ProviderRequestError("invalid-response");
  }
  if (
    !modules.some(
      (module) =>
        module?._type === "ResultsHeaderModule" &&
        Array.isArray(module.tabs) &&
        module.tabs.some((tab) => tab?.active === true),
    )
  ) {
    throw new ProviderRequestError("invalid-response");
  }
}

export async function checkProviderConnection(
  provider: SlabProvider,
  signal?: AbortSignal,
): Promise<void> {
  if (provider === "alt") {
    await requestSlabProvider(
      provider,
      {
        path: "/graphql/Me",
        body: JSON.stringify({
          operationName: "Me",
          variables: {},
          query: "query Me { me { id } }",
        }),
      },
      { signal, validate: validateAltConnection },
    );
    return;
  }
  const end = Date.now();
  const params = new URLSearchParams({
    marketplace: "EBAY-US",
    keywords: "Ponyta 60 1st PSA 9",
    dayRange: "90",
    startDate: String(end - 90 * 86_400_000),
    endDate: String(end),
    categoryId: "0",
    offset: "0",
    limit: "1",
    tabName: "SOLD",
    tz: "America/Chicago",
    modules: "resultsHeader",
  });
  await requestSlabProvider(
    provider,
    { path: `/sh/research/api/search?${params}` },
    { signal, validate: validateEbayConnection },
  );
}
