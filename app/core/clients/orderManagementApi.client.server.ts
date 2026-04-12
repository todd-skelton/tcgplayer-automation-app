/**
 * HTTP client for order-management-api.tcgplayer.com
 *
 * Used for:
 * - Seller order search
 * - Seller order detail retrieval
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const orderManagementApi = new DomainHttpClient(
  DOMAIN_KEYS.ORDER_MANAGEMENT_API,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.ORDER_MANAGEMENT_API]}`,
);
