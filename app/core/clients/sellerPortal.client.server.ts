/**
 * HTTP client for store.tcgplayer.com.
 *
 * Used for authenticated Seller Portal operations that are not exposed by the
 * official API, including inventory updates and staged pricing imports.
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const sellerPortal = new DomainHttpClient(
  DOMAIN_KEYS.SELLER_PORTAL,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.SELLER_PORTAL]}`,
);
