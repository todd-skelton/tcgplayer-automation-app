# Slab data connections

Settings → Slab data connections configures Alt and eBay Product Research independently. Apply migration `024_add_slab_provider_connections.sql` through the existing migration runner before serving this route. This slice only checks access; certificate resolution, evidence, valuation and publication are separate backlog issues.

## Connect and reconnect

Sign in normally to the provider in Chrome. In DevTools → Network, select a request to the endpoint below and copy the specified request headers into the connection form. Save, then select **Check access**. The form clears successful submissions and never loads a saved secret back into the browser.

| Provider | Observed endpoint | Form values | Read used to check access |
| --- | --- | --- | --- |
| Alt | `alt-platform-server.production.internal.onlyalt.com/graphql/Me` | Authorization token, with or without `Bearer ` | GraphQL `Me`, requesting only `id`; discard the response |
| eBay Product Research | `www.ebay.com/sh/research/api/search` | Cookie header and the same browser's User-Agent | A one-result sold search, requesting only the results header module |

The transport supplies Alt's Content-Type, Origin and Referer, and eBay's Research Referer. These headers plus the configured session material were sufficient in the verified calls. No Typesense search key, idempotency key, browser extension or seller OAuth configuration is needed for these checks. Seller API OAuth for later listing publication is a different connection.

Session lifetimes are controlled by the providers; no fixed renewal interval is assumed. HTTP redirects/401/403, HTML login responses, and Alt's unauthenticated/null-user response stop access with a reconnect message. Sign in again and replace the saved value. Credentials are read for each request, so no app or worker restart is needed. Removing a connection clears its credentials. An already running read may finish, but its result cannot overwrite the replacement/removal status.

The database stores credentials server-side, following the application's existing configuration model. Run this personal settings surface within the app's trusted access boundary; database backups contain these credentials. There is no new credential manager or application authentication system in this slice.

## Request ownership and bounds

All future interactive and worker adapters must compose `createProviderRequest` with `providerRequestGate`, using the same application database. The database row admits **one in-flight request per provider across all processes**, with at least two seconds between requests. Separate providers have independent rows; TCGplayer uses its existing path. Busy callers return immediately and future jobs should reschedule them rather than poll.

Requests use a fixed provider origin, manual redirects, a maximum 30-second HTTP deadline (including retries and body reads), at most three attempts, and a two-MiB decompressed response limit. Retry-After can defer the provider beyond the current request deadline; it is persisted without holding a process asleep for that duration. Transient/invalid responses impose a 30-second cooldown. Authentication failures stay blocked until credentials are replaced. Database gate queries have five-second read timeouts, in addition to the existing pool's connection timeout; database acquisition/cleanup can extend the elapsed operation beyond its HTTP deadline.

A 35-second lease recovers after a process exits. Lease IDs fence late cleanup, and credential revisions prevent old requests from changing a new connection's status. Saving/removing credentials preserves the current lease and cooldown. No Redis, extra worker, timer service, browser runtime or dependency is added.

## Verification

On September 5, 2026, authenticated reads succeeded through native fetch on the Windows host (Node 24.15.0) and a fresh `node:20-alpine` container (Node 20.20.2). Both used the same captured sessions; no production containers were modified. Invalid Alt credentials returned HTTP 200 with `me: null`, which is treated as reconnect-required.

Run normal tests with `npm test` and the isolated PostgreSQL test with:

```sh
npx tsx app/features/ebay-slab-pricing/connections/providerConnections.integration.test.ts
```

The integration test accepts only the local development database on port 5433 and creates/drops its own random schema. It verifies four-process exclusion, cooldown, lease expiry/fencing, replacement/removal, credential masking and reconnect without restart. Unit tests cover origin/credential isolation, redirects/authentication, throttling, stalled response deadlines, cancellation, response-size limits, provider response validation and masked form errors. No real credentials are required by committed tests.
