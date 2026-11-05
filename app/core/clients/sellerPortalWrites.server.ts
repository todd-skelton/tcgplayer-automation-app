/**
 * Seller Portal posts change the live store: prices, quantities and staged
 * pricing imports. They are refused unless SELLER_PORTAL_WRITES_ENABLED=true,
 * which only the production deployment sets, so a development run that plans a
 * publication cannot send it.
 */

export const SELLER_PORTAL_WRITES_VARIABLE = "SELLER_PORTAL_WRITES_ENABLED";

export class SellerPortalWritesDisabledError extends Error {
  readonly name = "SellerPortalWritesDisabledError";
  readonly code = "seller_portal_writes_disabled";

  constructor(path: string) {
    super(
      `Seller Portal writes are disabled, so ${path} was not sent. Set ${SELLER_PORTAL_WRITES_VARIABLE}=true where the live store may change.`,
    );
  }
}

export function sellerPortalWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SELLER_PORTAL_WRITES_VARIABLE] === "true";
}

export function requireSellerPortalWrites(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!sellerPortalWritesEnabled(env)) {
    throw new SellerPortalWritesDisabledError(path);
  }
}
