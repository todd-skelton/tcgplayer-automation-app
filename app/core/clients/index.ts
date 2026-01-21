/**
 * Domain-specific HTTP clients for TCGPlayer APIs
 *
 * Each client has isolated rate limiting, concurrency control, and cooldown state.
 * When one domain hits a rate limit, only that domain enters cooldown while others
 * continue operating normally.
 *
 * @example
 * import { mpSearchApi, mpApi, infiniteApi, mpGateway } from "~/core/clients";
 *
 * // Use relative paths - baseURL is already set
 * const result = await mpSearchApi.get<ProductResponse>("/v1/search/products");
 * const sales = await mpApi.post<SalesResponse>("/v2/product/123/latestsales", body);
 */

// Domain clients
export { mpSearchApi } from "./mpSearchApi.client.server";
export { mpApi } from "./mpApi.client.server";
export { infiniteApi } from "./infiniteApi.client.server";
export { mpGateway } from "./mpGateway.client.server";

// Base client class for advanced use cases
export { DomainHttpClient } from "./baseDomainClient.server";
