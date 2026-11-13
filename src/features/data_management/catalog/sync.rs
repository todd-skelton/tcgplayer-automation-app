//! A product line brought up to date with TCGplayer without walking the whole catalog
//! (`syncNewCatalogProducts`, `catalogSyncPlan`, `catalogSyncSummary`): one search counts every set's
//! products, and only the sets whose count differs from what is stored, or was last verified, are
//! searched, and only their missing or misfiled products read.
use std::collections::HashMap;

use sqlx::PgConnection;

use super::{
    refresh,
    source::{self, Catalog, Listed},
    store::{self, CategorySet, ProductLine, SetProduct},
};

/// One synced set: what was listed and stored, what changed, and whether every listed product is
/// now stored (so later syncs skip it until its count moves), or why not.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SetSync {
    pub set_name: String,
    pub listed_product_count: i64,
    pub stored_product_count_before: i64,
    pub new_product_count: usize,
    pub repaired_product_count: usize,
    pub skus_added: usize,
    pub verified: bool,
    pub problem: Option<String>,
}

/// What a sync did (`CatalogSyncResult`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Synced {
    pub product_line_name: String,
    pub listed_set_count: usize,
    pub listed_product_count: i64,
    /// Listed products the per-set counts leave out; sets holding them were not checked.
    pub uncounted_product_count: i64,
    pub synced_sets: Vec<SetSync>,
    pub unmatched_sets: Vec<Listed>,
}

/// A set needs syncing until it has been verified once, and afterwards whenever its listed count
/// moves or fewer products are stored than listed (`needsSync`).
fn needs_sync(listed: i64, stored: i64, verified: Option<i64>) -> bool {
    verified != Some(listed) || stored < listed
}

/// Stored in the set with its SKUs.
fn stored_in(placed: Option<&(i32, i64)>, set_name_id: i32) -> bool {
    placed.is_some_and(|(set, skus)| *set == set_name_id && *skus > 0)
}

/// The lock that keeps one product line synced once at a time.
fn lock_key(category_id: i32) -> String {
    format!("catalog-sync:{category_id}")
}

/// Takes the product line's sync lock on `conn`, or refuses as Node's in-process set did. The lock
/// is the session's, so it holds across every process (this app's instances, a release's two
/// sides), where Node's set held within one. A session lock outlives a dropped future, so the
/// caller's connection must close when it is dropped (`close_on_drop`), ending the lock with the
/// session if the sync is cut off (corten#607).
async fn start(conn: &mut PgConnection, category_id: i32) -> Result<(), String> {
    let taken: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1))")
        .bind(lock_key(category_id))
        .fetch_one(&mut *conn)
        .await
        .map_err(failed)?;
    if !taken {
        return Err("A sync is already running for this product line".to_owned());
    }
    Ok(())
}

/// Releases the lock `start` took. A failure leaves it to the session's end.
async fn finish(conn: &mut PgConnection, category_id: i32) {
    let _ = sqlx::query("SELECT pg_advisory_unlock(hashtext($1))")
        .bind(lock_key(category_id))
        .execute(&mut *conn)
        .await;
}

fn failed(e: sqlx::Error) -> String {
    e.to_string()
}

/// Syncs the product line `category_id`, one at a time per product line (see `start` for what
/// the connection must be).
pub async fn sync(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    category_id: i32,
) -> Result<Synced, String> {
    start(conn, category_id).await?;
    let synced = sync_line(conn, catalog, category_id).await;
    finish(conn, category_id).await;
    synced
}

async fn sync_line(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    category_id: i32,
) -> Result<Synced, String> {
    let (sets, line) = refresh::sets(conn, catalog, category_id).await?;
    let (listed_product_count, listed) =
        source::set_counts(catalog, &line.product_line_url_name).await?;
    let stored = store::stored_counts(conn, category_id)
        .await
        .map_err(failed)?;
    let verified = store::verified_counts(conn, category_id)
        .await
        .map_err(failed)?;
    if listed.is_empty() {
        return Err(format!(
            "TCGplayer search lists no sets for product line \"{}\"",
            line.product_line_url_name
        ));
    }
    let by_url: HashMap<&str, &CategorySet> =
        sets.iter().map(|s| (s.url_name.as_str(), s)).collect();
    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    for l in &listed {
        match by_url.get(l.url_name.as_str()) {
            Some(set) => matched.push((*set, l.product_count)),
            None => unmatched.push(l.clone()),
        }
    }
    let to_sync: Vec<(&CategorySet, i64, i64)> = matched
        .iter()
        .map(|(set, count)| {
            let stored = stored.get(&set.set_name_id).copied().unwrap_or(0);
            (*set, *count, stored)
        })
        .filter(|(set, count, stored)| {
            needs_sync(*count, *stored, verified.get(&set.set_name_id).copied())
        })
        .collect();
    tracing::info!(
        "[syncNewCatalogProducts] {}: {} of {} sets changed",
        line.product_line_name,
        to_sync.len(),
        matched.len()
    );
    let mut synced_sets = Vec::new();
    for (set, count, stored) in to_sync {
        synced_sets.push(sync_set(conn, catalog, &line, set, count, stored).await);
    }
    Ok(Synced {
        product_line_name: line.product_line_name.clone(),
        listed_set_count: listed.len(),
        listed_product_count,
        uncounted_product_count: listed_product_count
            - listed.iter().map(|l| l.product_count).sum::<i64>(),
        synced_sets,
        unmatched_sets: unmatched,
    })
}

/// One set synced (`syncSet`); what went wrong is its problem, not the sync's.
async fn sync_set(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    line: &ProductLine,
    set: &CategorySet,
    listed: i64,
    stored: i64,
) -> SetSync {
    let mut result = SetSync {
        set_name: set.name.clone(),
        listed_product_count: listed,
        stored_product_count_before: stored,
        ..SetSync::default()
    };
    if let Err(problem) = synced(conn, catalog, line, set, listed, &mut result).await {
        tracing::error!("[syncNewCatalogProducts] {} failed: {problem}", set.name);
        result.problem = Some(problem);
    }
    result
}

async fn synced(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    line: &ProductLine,
    set: &CategorySet,
    listed: i64,
    result: &mut SetSync,
) -> Result<(), String> {
    let found =
        source::set_products(catalog, &line.product_line_url_name, &set.url_name, 50).await?;
    let products = source::filed(&found, set.set_name_id, &line.product_line_name);
    let ids: Vec<i32> = products.iter().map(|p| p.product_id).collect();
    let line_id = line.product_line_id;
    let before = store::placed(conn, &ids, line_id).await.map_err(failed)?;
    // Listed products whose details or SKUs are missing, or filed under another set.
    let to_fetch: Vec<&SetProduct> = products
        .iter()
        .filter(|p| !stored_in(before.get(&p.product_id), set.set_name_id))
        .collect();
    if !to_fetch.is_empty() {
        let fetch: Vec<i32> = to_fetch.iter().map(|p| p.product_id).collect();
        let fetched = refresh::products_and_skus(conn, catalog, &fetch, line_id, true).await?;
        result.skus_added = fetched.skus_inserted;
    }
    // Listed products whose details confirm this set but whose filed set is missing or another.
    let placed = store::placed(conn, &ids, line_id).await.map_err(failed)?;
    let filed = store::filed(conn, &ids).await.map_err(failed)?;
    let to_file: Vec<SetProduct> = products
        .iter()
        .filter(|p| {
            placed.get(&p.product_id).map(|(set, _)| *set) == Some(set.set_name_id)
                && filed.get(&p.product_id) != Some(&set.set_name_id)
        })
        .cloned()
        .collect();
    store::save_set_products(conn, &to_file)
        .await
        .map_err(failed)?;
    let filed = store::filed(conn, &ids).await.map_err(failed)?;
    let placed = store::placed(conn, &ids, line_id).await.map_err(failed)?;
    let unstored: Vec<i32> = ids
        .iter()
        .copied()
        .filter(|id| {
            filed.get(id) != Some(&set.set_name_id) || !stored_in(placed.get(id), set.set_name_id)
        })
        .collect();
    let now_stored: Vec<i32> = to_fetch
        .iter()
        .map(|p| p.product_id)
        .filter(|id| !unstored.contains(id))
        .collect();
    result.new_product_count = now_stored
        .iter()
        .filter(|id| !before.contains_key(id))
        .count();
    result.repaired_product_count = now_stored.len() - result.new_product_count;
    if products.len() as i64 != listed {
        result.problem = Some(format!(
            "Search returned {} products but the set count is {listed}",
            products.len()
        ));
    } else if !unstored.is_empty() {
        let shown: Vec<String> = unstored.iter().take(10).map(i32::to_string).collect();
        result.problem = Some(format!(
            "{} listed products could not be stored in this set: {}{}",
            unstored.len(),
            shown.join(", "),
            if unstored.len() > 10 { ", ..." } else { "" }
        ));
    } else {
        store::record_verified(conn, set.set_name_id, listed)
            .await
            .map_err(failed)?;
        result.verified = true;
    }
    Ok(())
}

/// What a sync did, in the words the screen shows (`describeCatalogSync`).
pub fn describe(result: &Synced) -> String {
    let sum = |f: fn(&SetSync) -> usize| result.synced_sets.iter().map(f).sum::<usize>();
    let new_products = sum(|s| s.new_product_count);
    let repaired = sum(|s| s.repaired_product_count);
    let skus = sum(|s| s.skus_added);
    let synced = result.synced_sets.len();
    let unchanged =
        result.listed_set_count as i64 - result.unmatched_sets.len() as i64 - synced as i64;
    let verified = result.synced_sets.iter().filter(|s| s.verified).count();
    let mut lines = vec![
        format!(
            "{}: {} listed products in {} sets.",
            result.product_line_name, result.listed_product_count, result.listed_set_count
        ),
        format!(
            "Unchanged sets: {unchanged}. Synced sets: {synced} (verified: {verified}, not verified: {}).",
            synced - verified
        ),
        format!("New products: {new_products}. New SKUs: {skus}. Repaired products: {repaired}."),
    ];
    if result.uncounted_product_count != 0 {
        lines.push(format!(
            "WARNING: per-set counts account for {} of {} listed products, so some sets were not checked.",
            result.listed_product_count - result.uncounted_product_count,
            result.listed_product_count
        ));
    }
    for set in &result.synced_sets {
        let mut changes = vec![format!("{} new", set.new_product_count)];
        if set.repaired_product_count > 0 {
            changes.push(format!("{} repaired", set.repaired_product_count));
        }
        changes.push(format!("{} SKUs", set.skus_added));
        let outcome = match &set.problem {
            Some(problem) => format!("NOT VERIFIED: {problem}"),
            None => "verified".to_owned(),
        };
        lines.push(format!(
            "- {}: {} (listed {}, stored before {}) - {outcome}",
            set.set_name,
            changes.join(", "),
            set.listed_product_count,
            set.stored_product_count_before
        ));
    }
    for set in &result.unmatched_sets {
        lines.push(format!(
            "- {}: {} listed products, but TCGplayer's set list has no set with URL name \"{}\" - skipped",
            set.name, set.product_count, set.url_name
        ));
    }
    lines.join(
        "
",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `catalogSyncPlan.test.ts`'s needsSync cases.
    #[test]
    fn a_set_is_synced_until_verified_and_again_when_its_count_moves() {
        assert!(needs_sync(10, 10, None));
        assert!(!needs_sync(10, 10, Some(10)));
        assert!(needs_sync(11, 10, Some(10)));
        assert!(needs_sync(10, 9, Some(10)));
        assert!(!needs_sync(10, 12, Some(10)));
    }

    /// Two connections, as two processes: the second is refused while the first syncs, and
    /// takes the lock once the first finishes or its connection closes.
    #[tokio::test]
    #[ignore = "needs the dev database"]
    async fn one_product_line_is_synced_once_at_a_time_across_processes() {
        use sqlx::Connection;
        crate::config::load_env();
        let url = crate::config::database_url();
        let (mut one, mut two) = (
            PgConnection::connect(&url).await.unwrap(),
            PgConnection::connect(&url).await.unwrap(),
        );
        let line = -7;
        start(&mut one, line).await.unwrap();
        assert_eq!(
            start(&mut two, line).await.err().as_deref(),
            Some("A sync is already running for this product line")
        );
        finish(&mut one, line).await;
        start(&mut two, line).await.unwrap();
        two.close().await.unwrap();
        start(&mut one, line).await.unwrap();
        finish(&mut one, line).await;
        one.close().await.unwrap();
    }
}
