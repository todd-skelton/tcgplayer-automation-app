/**
 * HTTP client for mpapi.tcgplayer.com
 *
 * Used for:
 * - Catalog set names
 * - Latest sales data
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const mpApi = new DomainHttpClient(
  DOMAIN_KEYS.MPAPI,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.MPAPI]}`,
);
