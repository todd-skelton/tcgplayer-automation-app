/**
 * HTTP client for mp-search-api.tcgplayer.com
 *
 * Used for:
 * - Product search
 * - Category filters
 * - Product details
 * - Product listings
 * - Product lines
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const mpSearchApi = new DomainHttpClient(
  DOMAIN_KEYS.MP_SEARCH_API,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.MP_SEARCH_API]}`,
);
