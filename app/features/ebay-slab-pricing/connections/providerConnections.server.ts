import { randomUUID } from "node:crypto";
import { execute, query, getPool } from "~/core/db/database.server";
import {
  SLAB_PROVIDERS,
  type SlabProvider,
  type ProviderConnectionStatus,
} from "./providerConnection";
import {
  ProviderRequestError,
  PROVIDER_TIMEOUT_MS,
  type ProviderLease,
  type ProviderRequestGate,
} from "./providerRequest.server";

// pg supports per-query deadlines, but its QueryConfig type omits this option.
const QUERY_DEADLINE = { query_timeout: 5_000 };

export async function getProviderConnections(): Promise<
  ProviderConnectionStatus[]
> {
  const rows =
    await query<ProviderConnectionStatus>(`SELECT provider, credential <> '' AS configured,
    status, checked_at AS "checkedAt" FROM slab_provider_connections`);
  return SLAB_PROVIDERS.map(
    (provider) =>
      rows.find((row) => row.provider === provider) ?? {
        provider,
        configured: false,
        status: "not-configured",
        checkedAt: null,
      },
  );
}

export function validateCredential(
  provider: SlabProvider,
  credential: string,
  userAgent: string,
): string {
  const normalized =
    provider === "alt"
      ? credential.trim().replace(/^Bearer\s+/i, "")
      : credential.trim();
  if (
    !normalized ||
    normalized.length > 32_768 ||
    /[\r\n]/.test(normalized) ||
    userAgent.length > 512 ||
    /[\r\n]/.test(userAgent) ||
    (provider === "alt" && !/^[\w.\-]+$/.test(normalized)) ||
    (provider === "ebayResearch" &&
      (!normalized.includes("=") || !userAgent.trim()))
  ) {
    throw new Error(
      "Enter a valid connection value and browser user agent for eBay.",
    );
  }
  return normalized;
}

export async function saveProviderConnection(
  provider: SlabProvider,
  credential: string,
  userAgent: string,
): Promise<void> {
  const normalized = validateCredential(provider, credential, userAgent);
  await execute(
    `INSERT INTO slab_provider_connections (provider, credential, user_agent, revision, status)
    VALUES ($1, $2, $3, 1, 'unchecked') ON CONFLICT (provider) DO UPDATE
    SET credential = EXCLUDED.credential, user_agent = EXCLUDED.user_agent,
        revision = slab_provider_connections.revision + 1, status = 'unchecked', checked_at = NULL`,
    [provider, normalized, provider === "alt" ? "" : userAgent.trim()],
  );
}

export async function clearProviderConnection(
  provider: SlabProvider,
): Promise<void> {
  // Keep an in-flight lease/cooldown: clearing credentials must not admit a second request.
  await execute(
    `UPDATE slab_provider_connections SET credential = '', user_agent = '',
    revision = revision + 1, status = 'not-configured', checked_at = NULL WHERE provider = $1`,
    [provider],
  );
}

export const providerRequestGate: ProviderRequestGate = {
  async claim(provider) {
    const result = await getPool().query<ProviderLease>({
      ...QUERY_DEADLINE,
      text: `UPDATE slab_provider_connections
      SET lease_id = $2, lease_until = clock_timestamp() + $3 * interval '1 millisecond'
      WHERE provider = $1 AND credential <> '' AND status <> 'reconnect-required'
        AND next_request_at <= clock_timestamp()
        AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      RETURNING lease_id AS id, revision, credential, user_agent AS "userAgent"`,
      values: [provider, randomUUID(), PROVIDER_TIMEOUT_MS + 5_000],
    });
    const lease = result.rows[0];
    if (lease) return lease;
    const {
      rows: [row],
    } = await getPool().query<{ configured: boolean; status: string }>({
      ...QUERY_DEADLINE,
      text: `SELECT credential <> '' AS configured, status FROM slab_provider_connections WHERE provider = $1`,
      values: [provider],
    });
    throw new ProviderRequestError(
      !row?.configured
        ? "not-configured"
        : row.status === "reconnect-required"
          ? "reconnect-required"
          : "busy",
    );
  },
  async release(provider, lease, result) {
    await getPool().query({
      ...QUERY_DEADLINE,
      text: `UPDATE slab_provider_connections SET lease_id = NULL, lease_until = NULL,
      next_request_at = GREATEST(next_request_at, $4::timestamptz),
      status = CASE WHEN revision = $3 THEN $5 ELSE status END,
      checked_at = CASE WHEN revision = $3 THEN clock_timestamp() ELSE checked_at END
      WHERE provider = $1 AND lease_id = $2`,
      values: [
        provider,
        lease.id,
        lease.revision,
        new Date(result.retryAt),
        result.status,
      ],
    });
  },
};
