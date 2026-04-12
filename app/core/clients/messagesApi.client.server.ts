/**
 * HTTP client for messages-api.tcgplayer.com
 *
 * Used for:
 * - Seller order thread creation
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const messagesApi = new DomainHttpClient(
  DOMAIN_KEYS.MESSAGES_API,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.MESSAGES_API]}`,
);
