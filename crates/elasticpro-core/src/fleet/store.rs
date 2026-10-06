//! Where cached datasets live beyond memory: a disk copy so a restart starts from the
//! last known state instead of from nothing, and — hosted only — Redis, for anything
//! else on the box that wants the same answers without asking the clusters again.
//!
//! Both are best-effort by design. The cache is a copy of what the clusters said; losing
//! it costs one round of polling, so no failure here is ever allowed to stop the poller.

use super::catalogue::Dataset;
use super::entry::{Entry, Status};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Above this a cache file is gzipped, and written at most once a minute.
pub const BIG_BYTES: usize = 64 * 1024;
const DEBOUNCE_MS: u64 = 60_000;

/// A cluster id as a directory name. Ids come from a config and from Zabbix; nothing
/// stops one containing a slash, and a slash in a path is a way out of the cache dir.
fn escape(id: &str) -> String {
    let mut s = String::new();
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
            s.push(b as char);
        } else {
            s.push_str(&format!("%{b:02X}"));
        }
    }
    s
}

fn unescape(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(unix)]
fn private(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn private(_: &Path, _: u32) {}

pub struct DiskStore {
    dir: Option<PathBuf>,
    last_write: Mutex<HashMap<(String, Dataset), u64>>,
}

impl DiskStore {
    /// `data_dir/cache`, or nowhere at all when the core has no data dir.
    pub fn new(data_dir: Option<&Path>) -> DiskStore {
        DiskStore { dir: data_dir.map(|d| d.join("cache")), last_write: Mutex::new(HashMap::new()) }
    }

    fn file(&self, cluster: &str, ds: Dataset, gz: bool) -> Option<PathBuf> {
        let d = self.dir.as_ref()?.join(escape(cluster));
        Some(d.join(format!("{}.json{}", ds.name(), if gz { ".gz" } else { "" })))
    }

    /// Keep one entry. Only a good one: a failure is not worth remembering across a
    /// restart, and writing it would replace the good body the disk already holds.
    ///
    /// Blocking file I/O — call it from `spawn_blocking`.
    pub fn save(&self, cluster: &str, ds: Dataset, entry: &Entry, now: u64) {
        if entry.status != Status::Ok || self.dir.is_none() {
            return;
        }
        let Ok(body) = serde_json::to_vec(entry) else { return };
        let big = body.len() > BIG_BYTES;
        if big {
            let mut lw = self.last_write.lock();
            let k = (cluster.to_string(), ds);
            if lw.get(&k).is_some_and(|t| now.saturating_sub(*t) < DEBOUNCE_MS) {
                return;
            }
            lw.insert(k, now);
        }
        let (Some(path), Some(other)) = (self.file(cluster, ds, big), self.file(cluster, ds, !big)) else { return };
        if let Some(dir) = path.parent() {
            if std::fs::create_dir_all(dir).is_err() {
                return;
            }
            private(dir, 0o700);
            if let Some(root) = dir.parent() {
                private(root, 0o700);
            }
        }
        let bytes = if big {
            use std::io::Write;
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            if enc.write_all(&body).is_err() {
                return;
            }
            match enc.finish() {
                Ok(b) => b,
                Err(_) => return,
            }
        } else {
            body
        };
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, &bytes).is_err() {
            return;
        }
        private(&tmp, 0o600);
        if std::fs::rename(&tmp, &path).is_ok() {
            // A dataset that shrank below the threshold must not leave its old .gz to be
            // restored instead.
            let _ = std::fs::remove_file(other);
        }
    }

    /// Everything on disk, as `restored` entries. Unreadable files are skipped: a cache
    /// that cannot be read is a cache miss, not a reason to fail a start.
    pub fn load_all(&self) -> Vec<(String, Dataset, Entry)> {
        let mut out = vec![];
        let Some(root) = &self.dir else { return out };
        let Ok(clusters) = std::fs::read_dir(root) else { return out };
        for c in clusters.flatten() {
            let Some(id) = c.file_name().to_str().and_then(unescape) else { continue };
            let Ok(files) = std::fs::read_dir(c.path()) else { continue };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                let (stem, gz) = match (name.strip_suffix(".json.gz"), name.strip_suffix(".json")) {
                    (Some(s), _) => (s.to_string(), true),
                    (None, Some(s)) => (s.to_string(), false),
                    _ => continue,
                };
                let Some(ds) = Dataset::parse(&stem) else { continue };
                let Ok(raw) = std::fs::read(f.path()) else { continue };
                let body = if gz {
                    use std::io::Read;
                    let mut s = Vec::new();
                    if flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut s).is_err() {
                        continue;
                    }
                    s
                } else {
                    raw
                };
                let Ok(mut e) = serde_json::from_slice::<Entry>(&body) else { continue };
                e.status = Status::Restored;
                e.bytes = body.len();
                e.next_due = None;
                e.error = None;
                out.push((id.clone(), ds, e));
            }
        }
        out
    }

    /// Drop every cluster not in `keep`, on disk.
    pub fn prune(&self, keep: &HashSet<String>) {
        let Some(root) = &self.dir else { return };
        let Ok(clusters) = std::fs::read_dir(root) else { return };
        for c in clusters.flatten() {
            let id = c.file_name().to_str().and_then(unescape);
            if id.is_some_and(|id| !keep.contains(&id)) {
                let _ = std::fs::remove_dir_all(c.path());
            }
        }
        self.last_write.lock().retain(|(c, _), _| keep.contains(c));
    }
}

/* ------------------------------------ Redis ------------------------------------ */

/// Redis, when `ELASTICPRO_REDIS_URL` names one. Write-through only: this core is the one
/// replica and its memory is the source of truth, so Redis is never read on the hot path —
/// only at start-up, alongside the disk, and by whatever else subscribes to
/// `elasticpro:updates`.
#[cfg(feature = "bridge")]
pub struct RedisStore {
    client: Option<redis::Client>,
    conn: tokio::sync::Mutex<Option<redis::aio::MultiplexedConnection>>,
    last_try: Mutex<Option<std::time::Instant>>,
    last_log: Mutex<Option<std::time::Instant>>,
}

#[cfg(feature = "bridge")]
pub const UPDATES_CHANNEL: &str = "elasticpro:updates";

#[cfg(feature = "bridge")]
pub fn redis_key(cluster: &str, ds: Dataset) -> String {
    format!("elasticpro:ds:{cluster}:{}", ds.name())
}

#[cfg(feature = "bridge")]
impl RedisStore {
    pub fn from_env() -> RedisStore {
        let url = std::env::var("ELASTICPRO_REDIS_URL").ok().filter(|u| !u.trim().is_empty());
        let client = url.and_then(|u| match redis::Client::open(u.trim()) {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!("ELASTICPRO_REDIS_URL is not usable ({e}); the fleet cache runs on memory and disk");
                None
            }
        });
        RedisStore {
            client,
            conn: tokio::sync::Mutex::new(None),
            last_try: Mutex::new(None),
            last_log: Mutex::new(None),
        }
    }

    pub fn configured(&self) -> bool {
        self.client.is_some()
    }

    /// Redis being down is logged once a minute, not once per write: with a hundred
    /// clusters that would be the whole log.
    fn down(&self, what: &str, e: &dyn std::fmt::Display) {
        let mut l = self.last_log.lock();
        if l.is_none_or(|t| t.elapsed() >= std::time::Duration::from_secs(60)) {
            *l = Some(std::time::Instant::now());
            tracing::warn!("redis {what}: {e} — carrying on with memory and disk");
        }
    }

    /// A live connection, or `None` without waiting when one failed in the last few
    /// seconds. Reconnecting is done here, by hand, rather than by redis-rs's connection
    /// manager: its retries run inside the call, and this must never be slow.
    async fn conn(&self) -> Option<redis::aio::MultiplexedConnection> {
        let client = self.client.as_ref()?;
        let mut g = self.conn.lock().await;
        if let Some(c) = g.as_ref() {
            return Some(c.clone());
        }
        // Not every write tries to connect: a Redis that is down would otherwise cost a
        // connect timeout on every dataset the poller finishes.
        {
            let mut t = self.last_try.lock();
            if t.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(5)) {
                return None;
            }
            *t = Some(std::time::Instant::now());
        }
        match tokio::time::timeout(std::time::Duration::from_secs(2), client.get_multiplexed_async_connection()).await {
            Ok(Ok(c)) => {
                tracing::info!("redis connected: the fleet cache writes through to it");
                *g = Some(c.clone());
                Some(c)
            }
            Ok(Err(e)) => {
                self.down("connect", &e);
                None
            }
            Err(_) => {
                self.down("connect", &"timed out");
                None
            }
        }
    }

    async fn run<T: redis::FromRedisValue>(&self, what: &str, cmd: redis::Cmd) -> Option<T> {
        let mut c = self.conn().await?;
        let lost = match tokio::time::timeout(std::time::Duration::from_secs(2), cmd.query_async::<T>(&mut c)).await {
            Ok(Ok(v)) => return Some(v),
            Ok(Err(e)) => {
                self.down(what, &e);
                // A reply Redis sent (a wrong type, an OOM refusal) leaves the connection
                // good; anything else means the next call should reconnect.
                e.is_io_error() || e.is_connection_dropped() || e.is_timeout()
            }
            Err(_) => {
                self.down(what, &"timed out");
                true
            }
        };
        if lost {
            *self.conn.lock().await = None;
        }
        None
    }

    /// `SET elasticpro:ds:{cluster}:{dataset} <entry> EX ttl`, then announce it.
    pub async fn put(&self, cluster: &str, ds: Dataset, body: &str, ttl_secs: u64, update: &str) {
        if self.client.is_none() {
            return;
        }
        let mut set = redis::cmd("SET");
        set.arg(redis_key(cluster, ds)).arg(body).arg("EX").arg(ttl_secs.max(1));
        if self.run::<()>("set", set).await.is_none() {
            return;
        }
        let mut publish = redis::cmd("PUBLISH");
        publish.arg(UPDATES_CHANNEL).arg(update);
        let _ = self.run::<i64>("publish", publish).await;
    }

    pub async fn remove_cluster(&self, cluster: &str) {
        if self.client.is_none() {
            return;
        }
        let mut del = redis::cmd("DEL");
        for d in super::catalogue::ALL {
            del.arg(redis_key(cluster, d));
        }
        let _ = self.run::<i64>("del", del).await;
    }

    /// Every entry Redis still holds, as `restored`.
    pub async fn load_all(&self) -> Vec<(String, Dataset, Entry)> {
        let mut out = vec![];
        if self.client.is_none() {
            return out;
        }
        let mut cursor: u64 = 0;
        let mut keys: Vec<String> = vec![];
        loop {
            let mut scan = redis::cmd("SCAN");
            scan.arg(cursor).arg("MATCH").arg("elasticpro:ds:*").arg("COUNT").arg(500);
            let Some((next, batch)) = self.run::<(u64, Vec<String>)>("scan", scan).await else { return out };
            keys.extend(batch);
            cursor = next;
            if cursor == 0 || keys.len() > 100_000 {
                break;
            }
        }
        for k in keys {
            let Some((cluster, ds)) = k.strip_prefix("elasticpro:ds:").and_then(|r| r.rsplit_once(':')) else { continue };
            let Some(ds) = Dataset::parse(ds) else { continue };
            let mut get = redis::cmd("GET");
            get.arg(&k);
            let Some(body) = self.run::<Option<String>>("get", get).await.flatten() else { continue };
            let Ok(mut e) = serde_json::from_str::<Entry>(&body) else { continue };
            e.status = Status::Restored;
            e.bytes = body.len();
            e.next_due = None;
            e.error = None;
            out.push((cluster.to_string(), ds, e));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cluster_ids_cannot_escape_the_cache_dir() {
        assert_eq!(escape("../etc"), "%2E%2E%2Fetc");
        assert_eq!(unescape(&escape("a/b c:ü")).as_deref(), Some("a/b c:ü"));
        assert_eq!(escape("prod-1_eu"), "prod-1_eu");
    }

    fn ok_entry(data: serde_json::Value) -> Entry {
        let mut e = Entry::never(1, None);
        e.status = Status::Ok;
        e.fetched_at = Some(1000);
        e.data = Some(data);
        e
    }

    #[test]
    fn big_entries_are_gzipped_and_come_back() {
        let dir = std::env::temp_dir().join(format!("elasticpro-store-{}", std::process::id()));
        let s = DiskStore::new(Some(&dir));
        let big = "x".repeat(BIG_BYTES + 10);
        s.save("c1", Dataset::Indices, &ok_entry(json!({ "indices": { "json": big } })), 0);
        s.save("c1", Dataset::Health, &ok_entry(json!({ "health": { "json": {"status": "green"} } })), 0);
        assert!(dir.join("cache/c1/indices.json.gz").exists());
        assert!(dir.join("cache/c1/health.json").exists());
        let back = s.load_all();
        assert_eq!(back.len(), 2);
        assert!(back.iter().all(|(_, _, e)| e.status == Status::Restored && e.fetched_at == Some(1000)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
