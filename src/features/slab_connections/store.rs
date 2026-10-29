//! The saved connections (`slab_provider_connections`), ported from
//! `connections/providerConnections.server.ts`. The table is also the [`Gate`] every process
//! shares: a lease row per provider, its expiry, and when the provider may be asked again.
use std::{future::Future, time::Duration};

use chrono::{DateTime, Utc};

use super::{
    provider::{Connection, Credential, Provider, Status},
    request::{self, Gate, Lease},
};
use crate::database::Database;

/// The longest a gate query may take before the request is called unavailable.
const QUERY_DEADLINE: Duration = Duration::from_secs(5);

/// Each provider's connection, in the order the screen lists them; a provider never saved has
/// none.
pub async fn connections(db: &Database) -> sqlx::Result<Vec<Connection>> {
    let rows: Vec<(String, bool, String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT provider, credential <> '', status, checked_at FROM slab_provider_connections",
    )
    .fetch_all(&db.0)
    .await?;
    Ok(Provider::ALL
        .into_iter()
        .map(|provider| {
            rows.iter()
                .find(|(key, ..)| key == provider.as_ref())
                .map_or_else(
                    || Connection::none(provider),
                    |(_, configured, status, checked_at)| Connection {
                        provider,
                        configured: *configured,
                        status: Status::stored(status),
                        checked_at: *checked_at,
                    },
                )
        })
        .collect())
}

/// Saves a new credential, unchecked. The revision moves on, so a check still running with the
/// old one does not write its result over this.
pub async fn save(db: &Database, provider: Provider, credential: &Credential) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO slab_provider_connections (provider, credential, user_agent, revision, status)
        VALUES ($1, $2, $3, 1, 'unchecked') ON CONFLICT (provider) DO UPDATE
        SET credential = EXCLUDED.credential, user_agent = EXCLUDED.user_agent,
            revision = slab_provider_connections.revision + 1, status = 'unchecked', checked_at = NULL",
    )
    .bind(provider.as_ref())
    .bind(&credential.secret)
    .bind(&credential.user_agent)
    .execute(&db.0)
    .await?;
    Ok(())
}

/// Forgets the credential. A lease and cooldown in progress stay: removing a credential must not
/// let a second request through.
pub async fn remove(db: &Database, provider: Provider) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE slab_provider_connections SET credential = '', user_agent = '',
        revision = revision + 1, status = 'not-configured', checked_at = NULL WHERE provider = $1",
    )
    .bind(provider.as_ref())
    .execute(&db.0)
    .await?;
    Ok(())
}

/// The table as the gate. A lease lasts the request's longest time and five seconds more, so a
/// process that died holding one frees the provider by itself.
#[derive(Clone)]
pub struct DatabaseGate(pub Database);

impl Gate for DatabaseGate {
    async fn claim(&self, provider: Provider) -> Result<Lease, Status> {
        let lease_ms = (request::TIMEOUT + Duration::from_secs(5)).as_millis() as i64;
        let claimed: Option<(String, i32, String, String)> = within_deadline(
            sqlx::query_as(
                "UPDATE slab_provider_connections
                SET lease_id = gen_random_uuid(), lease_until = clock_timestamp() + $2 * interval '1 millisecond'
                WHERE provider = $1 AND credential <> '' AND status <> 'reconnect-required'
                  AND next_request_at <= clock_timestamp()
                  AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                RETURNING lease_id::text, revision, credential, user_agent",
            )
            .bind(provider.as_ref())
            .bind(lease_ms)
            .fetch_optional(&self.0.0),
        )
        .await?;
        if let Some((id, revision, secret, user_agent)) = claimed {
            return Ok(Lease {
                id,
                revision,
                secret,
                user_agent,
            });
        }
        let row: Option<(bool, String)> = within_deadline(
            sqlx::query_as("SELECT credential <> '', status FROM slab_provider_connections WHERE provider = $1")
                .bind(provider.as_ref())
                .fetch_optional(&self.0.0),
        )
        .await?;
        Err(match row {
            Some((true, status)) if status == Status::ReconnectRequired.as_ref() => {
                Status::ReconnectRequired
            }
            Some((true, _)) => Status::Busy,
            _ => Status::NotConfigured,
        })
    }

    /// Frees the provider no sooner than `retry_at`, and records the outcome unless the
    /// credential was replaced or removed meanwhile.
    async fn release(
        &self,
        provider: Provider,
        lease: &Lease,
        status: Status,
        retry_at: DateTime<Utc>,
    ) -> Result<(), Status> {
        within_deadline(
            sqlx::query(
                "UPDATE slab_provider_connections SET lease_id = NULL, lease_until = NULL,
                next_request_at = GREATEST(next_request_at, $4),
                status = CASE WHEN revision = $3 THEN $5 ELSE status END,
                checked_at = CASE WHEN revision = $3 THEN clock_timestamp() ELSE checked_at END
                WHERE provider = $1 AND lease_id = $2::uuid",
            )
            .bind(provider.as_ref())
            .bind(&lease.id)
            .bind(lease.revision)
            .bind(retry_at)
            .bind(status.as_ref())
            .execute(&self.0.0),
        )
        .await
        .map(drop)
    }
}

/// A gate query's answer, or unavailable when it failed or took too long. Its error is never
/// shown: it can name the database.
async fn within_deadline<T>(query: impl Future<Output = sqlx::Result<T>>) -> Result<T, Status> {
    match tokio::time::timeout(QUERY_DEADLINE, query).await {
        Ok(Ok(answer)) => Ok(answer),
        _ => Err(Status::Unavailable),
    }
}
