CREATE TABLE slab_provider_connections (
  provider text PRIMARY KEY CHECK (provider IN ('alt', 'ebayResearch')),
  credential text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not-configured',
  checked_at timestamptz,
  next_request_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_id uuid,
  lease_until timestamptz
);
