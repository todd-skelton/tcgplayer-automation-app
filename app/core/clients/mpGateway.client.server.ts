/**
 * HTTP client for mpgateway.tcgplayer.com
 *
 * Used for:
 * - Price points / market prices
 */

import { DOMAIN_KEYS, TCGPLAYER_DOMAINS } from "../config/httpConfig.server";
import { DomainHttpClient } from "./baseDomainClient.server";

export const mpGateway = new DomainHttpClient(
  DOMAIN_KEYS.MP_GATEWAY,
  `https://${TCGPLAYER_DOMAINS[DOMAIN_KEYS.MP_GATEWAY]}`,
);
