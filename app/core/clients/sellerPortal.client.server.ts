/**
 * HTTP client for store.tcgplayer.com.
 *
 * Used for authenticated Seller Portal operations that are not exposed by the
 * official API, including inventory updates and staged pricing imports. Every
 * post changes the live store, so each is refused unless writes are enabled.
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";
import { requireSellerPortalWrites } from "./sellerPortalWrites.server";

export const sellerPortal = new DomainHttpClient(
  DOMAIN_KEYS.SELLER_PORTAL,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.SELLER_PORTAL]}`,
  (path) => requireSellerPortalWrites(path),
);
