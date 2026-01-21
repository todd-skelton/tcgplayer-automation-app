/**
 * HTTP client for infinite-api.tcgplayer.com
 *
 * Used for:
 * - Set cards data
 * - Price history
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const infiniteApi = new DomainHttpClient(
  DOMAIN_KEYS.INFINITE_API,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.INFINITE_API]}`,
);
