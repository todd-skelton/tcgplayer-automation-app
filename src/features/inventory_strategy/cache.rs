//! One value per key, rebuilt whenever its identity or version changes: `versionedCache.ts`. A
//! changed version serves the last value at once while the new one builds, so only the first read
//! of a key, or one whose identity changed, waits. One build runs per key at a time; a version that
//! moves during a build is picked up by the next read. A failed rebuild keeps serving the last
//! value and is retried on the next read.
use std::{collections::HashMap, future::Future, sync::Mutex};

use tokio::sync::watch;

type Outcome<V> = Option<Result<V, String>>;

struct Build<V> {
    id: u64,
    outcome: watch::Receiver<Outcome<V>>,
}

struct Entry<V> {
    identity: String,
    ready: Option<(String, V)>,
    building: Option<Build<V>>,
}

pub struct VersionedCache<V> {
    name: &'static str,
    entries: Mutex<HashMap<String, Entry<V>>>,
    builds: std::sync::atomic::AtomicU64,
}

impl<V: Clone + Send + Sync + 'static> VersionedCache<V> {
    pub fn new(name: &'static str) -> Self {
        VersionedCache {
            name,
            entries: Mutex::new(HashMap::new()),
            builds: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// The value for the key at this identity and version, building it when it is missing.
    pub async fn read<F, Fut>(
        &'static self,
        key: &str,
        identity: &str,
        version: &str,
        build: F,
    ) -> Result<V, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, String>> + Send + 'static,
    {
        let mut outcome = {
            let mut entries = self.entries.lock().expect("the cache lock");
            let entry = entries.entry(key.to_string()).or_insert_with(|| Entry {
                identity: identity.to_string(),
                ready: None,
                building: None,
            });
            if entry.identity != identity {
                *entry = Entry {
                    identity: identity.to_string(),
                    ready: None,
                    building: None,
                };
            }
            if let Some((ready_version, value)) = &entry.ready
                && ready_version == version
            {
                return Ok(value.clone());
            }
            if entry.building.is_none() {
                entry.building = Some(self.start(key, identity, version, build()));
            }
            if let Some((_, value)) = &entry.ready {
                return Ok(value.clone());
            }
            entry.building.as_ref().expect("a build").outcome.clone()
        };
        let finished = outcome
            .wait_for(Option::is_some)
            .await
            .map_err(|e| e.to_string())?;
        finished.clone().expect("a finished build")
    }

    fn start(
        &'static self,
        key: &str,
        identity: &str,
        version: &str,
        build: impl Future<Output = Result<V, String>> + Send + 'static,
    ) -> Build<V> {
        let id = self
            .builds
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (send, outcome) = watch::channel(None);
        let (key, identity, version) = (key.to_string(), identity.to_string(), version.to_string());
        tokio::spawn(async move {
            let result = build.await;
            {
                let mut entries = self.entries.lock().expect("the cache lock");
                if let Some(entry) = entries.get_mut(&key).filter(|e| e.identity == identity) {
                    match &result {
                        Ok(value) => entry.ready = Some((version, value.clone())),
                        Err(why) if entry.ready.is_some() => {
                            eprintln!("{} rebuild failed: {why}", self.name)
                        }
                        Err(_) => {}
                    }
                    if entry.building.as_ref().is_some_and(|b| b.id == id) {
                        entry.building = None;
                    }
                }
            }
            send.send_replace(Some(result));
        });
        Build { id, outcome }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering},
    };

    use tokio::sync::oneshot;

    use super::*;

    static CACHE: LazyLock<VersionedCache<String>> = LazyLock::new(|| VersionedCache::new("test"));
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    static PENDING: Mutex<Vec<oneshot::Sender<Result<String, String>>>> = Mutex::new(Vec::new());

    /// A build that finishes when the test says so.
    fn build() -> impl Future<Output = Result<String, String>> + Send + 'static {
        BUILDS.fetch_add(1, Ordering::SeqCst);
        let (send, receive) = oneshot::channel();
        PENDING.lock().unwrap().push(send);
        async move { receive.await.unwrap_or_else(|_| Err("dropped".into())) }
    }

    fn finish(result: Result<&str, &str>) {
        let send = PENDING.lock().unwrap().remove(0);
        send.send(result.map(str::to_string).map_err(str::to_string))
            .unwrap();
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    fn builds() -> usize {
        BUILDS.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn serves_the_last_value_while_a_newer_version_builds() {
        let read = |key: &'static str, identity: &'static str, version: &'static str| {
            tokio::spawn(CACHE.read(key, identity, version, build))
        };
        let first = read("seller", "config-a", "v1");
        settle().await;
        let again = read("seller", "config-a", "v1");
        settle().await;
        assert_eq!(builds(), 1, "concurrent first reads share one build");
        finish(Ok("built-1"));
        assert_eq!(
            first.await.unwrap().unwrap(),
            "built-1",
            "the first read waits for its build"
        );
        assert_eq!(again.await.unwrap().unwrap(), "built-1");
        assert_eq!(
            CACHE.read("seller", "config-a", "v1", build).await.unwrap(),
            "built-1"
        );
        assert_eq!(builds(), 1, "an unchanged version is served from cache");

        assert_eq!(
            CACHE.read("seller", "config-a", "v2", build).await.unwrap(),
            "built-1",
            "a changed version serves the last value"
        );
        assert_eq!(builds(), 2, "and starts a rebuild");
        assert_eq!(
            CACHE.read("seller", "config-a", "v3", build).await.unwrap(),
            "built-1"
        );
        assert_eq!(
            builds(),
            2,
            "a version that moves during a build does not start another"
        );
        finish(Ok("built-2"));
        settle().await;
        assert_eq!(
            CACHE.read("seller", "config-a", "v2", build).await.unwrap(),
            "built-2",
            "the finished build is served at its version"
        );
        assert_eq!(
            CACHE.read("seller", "config-a", "v3", build).await.unwrap(),
            "built-2"
        );
        assert_eq!(
            builds(),
            3,
            "the next read after a build catches up to the newer version"
        );
        finish(Err("source down"));
        settle().await;
        assert_eq!(
            CACHE.read("seller", "config-a", "v2", build).await.unwrap(),
            "built-2",
            "a failed rebuild keeps serving the last value"
        );
        assert_eq!(builds(), 3);
        CACHE.read("seller", "config-a", "v3", build).await.unwrap();
        assert_eq!(builds(), 4, "and the next read retries it");
        finish(Ok("built-3"));
        settle().await;

        let reconfigured = read("seller", "config-b", "v3");
        settle().await;
        assert_eq!(builds(), 5, "a changed identity rebuilds");
        finish(Ok("built-4"));
        assert_eq!(
            reconfigured.await.unwrap().unwrap(),
            "built-4",
            "and waits instead of serving the old identity"
        );

        let rejected = read("other", "config-a", "v1");
        settle().await;
        finish(Err("source down"));
        assert_eq!(
            rejected.await.unwrap().unwrap_err(),
            "source down",
            "a first build that fails rejects"
        );
        let retried = read("other", "config-a", "v1");
        settle().await;
        assert_eq!(builds(), 7, "and the next read builds again");
        finish(Ok("built-5"));
        assert_eq!(retried.await.unwrap().unwrap(), "built-5");
    }
}
