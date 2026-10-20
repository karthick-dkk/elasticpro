//! Where cached datasets live beyond memory: a disk copy so a restart starts from the
//! last known state instead of from nothing, and — hosted only — Redis, for anything
//! else on the box that wants the same answers without asking the clusters again.
//!
//! Both are best-effort by design. The cache is a copy of what the clusters said; losing
//! it costs one round of polling, so no failure here is ever allowed to stop the poller.

use super::catalogue::{Class, Dataset};
use super::entry::{Entry, Status, ENTRY_OVERHEAD};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Above this a cache file is gzipped, and written at most once a minute.
pub const BIG_BYTES: usize = 64 * 1024;
const DEBOUNCE_MS: u64 = 60_000;

/// A cluster id as a directory name. Ids come from a config and from Zabbix; nothing
/// stops one containing a slash, and a slash in a path is a way out of the cache dir.
pub(crate) fn escape(id: &str) -> String {
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

pub(crate) fn unescape(s: &str) -> Option<String> {
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

/* --------------------------------- restoring --------------------------------- */

/// How much of an entry's start is read to learn when it was fetched. `Entry` serialises
/// `status` then `fetchedAt` first, so this is generous.
const HEAD_BYTES: usize = 256;

/// `fetchedAt` from the start of a serialised entry, without reading the rest: `Some(t)`
/// for a time, `Some(None)` for `null`, `None` when the head does not say.
pub fn head_fetched_at(head: &[u8]) -> Option<Option<u64>> {
    let text = std::str::from_utf8(head).unwrap_or_else(|e| std::str::from_utf8(&head[..e.valid_up_to()]).unwrap_or(""));
    let rest = text[text.find("\"fetchedAt\"")? + 11..].trim_start().strip_prefix(':')?.trim_start();
    if rest.starts_with("null") {
        return Some(None);
    }
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    // Digits running to the end of the head may be cut short: not an answer.
    if digits.is_empty() || digits.len() == rest.len() {
        return None;
    }
    digits.parse().ok().map(Some)
}

/// Where a found entry's body is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Where {
    Disk { path: PathBuf, gz: bool },
    Redis(String),
}

/// A cached entry found in a store, before its body is read: enough to decide whether it
/// is worth reading at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub cluster: String,
    pub ds: Dataset,
    pub fetched_at: Option<u64>,
    /// The serialised entry's length — what its body will cost, near enough.
    pub bytes: usize,
    pub at: Where,
}

impl Found {
    /// What restoring it will cost the cache, by the same measure as `Entry::cost`.
    pub fn cost(&self) -> usize {
        ENTRY_OVERHEAD + self.bytes
    }
}

/// The order a restore reads in — the reverse of the order `State::evict` drops in: every
/// cluster's health first, then the other background datasets, then the on-demand ones,
/// newest first within each. With a budget smaller than the cache, what is left out is
/// what eviction would have dropped first.
pub fn restore_order(found: &mut [Found]) {
    found.sort_by_key(|f| {
        let rank = match (f.ds, f.ds.class()) {
            (Dataset::Health, _) => 0u8,
            (_, Class::Background) => 1,
            (_, Class::OnDemand) => 2,
        };
        (rank, std::cmp::Reverse(f.fetched_at))
    });
}

/// A serialised entry, as restored: `restored`, nothing due, no error carried over.
fn restored(body: &[u8]) -> Option<Entry> {
    let mut e = serde_json::from_slice::<Entry>(body).ok()?;
    e.status = Status::Restored;
    e.next_due = None;
    e.error = None;
    Some(e)
}

pub struct DiskStore {
    dir: Option<PathBuf>,
    last_write: Mutex<HashMap<(String, Dataset), u64>>,
}

impl DiskStore {
    /// `data_dir/cache`, or nowhere at all when the core has no data dir.
    pub fn new(data_dir: Option<&Path>) -> DiskStore {
        DiskStore { dir: data_dir.map(|d| d.join("cache")), last_write: Mutex::new(HashMap::new()) }
    }

    /// The cache folder (`data_dir/cache`), for the housekeeping sweep.
    pub(crate) fn root(&self) -> Option<&Path> {
        self.dir.as_deref()
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

    /// Every entry on disk, from the first few hundred bytes of each file and its size —
    /// no body is read. Unreadable files are skipped: a cache that cannot be read is a
    /// cache miss, not a reason to fail a start.
    pub fn found(&self) -> Vec<Found> {
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
                let path = f.path();
                let Some((head, bytes)) = disk_head(&path, gz) else { continue };
                let Some(fetched_at) = head_fetched_at(&head) else { continue };
                out.push(Found { cluster: id.clone(), ds, fetched_at, bytes, at: Where::Disk { path, gz } });
            }
        }
        out
    }

    /// One found entry, read whole, as `restored`.
    pub fn load(&self, f: &Found) -> Option<Entry> {
        let Where::Disk { path, gz } = &f.at else { return None };
        let raw = std::fs::read(path).ok()?;
        if *gz {
            use std::io::Read;
            let mut s = Vec::with_capacity(f.bytes);
            flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut s).ok()?;
            drop(raw);
            restored(&s)
        } else {
            restored(&raw)
        }
    }

    /// Everything on disk, as `restored` entries, regardless of any budget. For tests.
    #[doc(hidden)]
    pub fn load_all(&self) -> Vec<(String, Dataset, Entry)> {
        self.found().into_iter().filter_map(|f| self.load(&f).map(|e| (f.cluster, f.ds, e))).collect()
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

/// The start of a cache file, decoded, and the length of the whole of it decoded. A gzip
/// file says its decoded length in its last four bytes (mod 4 GiB, more than any body).
fn disk_head(path: &Path, gz: bool) -> Option<(Vec<u8>, usize)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut head = Vec::with_capacity(HEAD_BYTES);
    if gz {
        if len < 18 {
            return None;
        }
        file.seek(SeekFrom::End(-4)).ok()?;
        let mut isize = [0u8; 4];
        file.read_exact(&mut isize).ok()?;
        file.seek(SeekFrom::Start(0)).ok()?;
        flate2::read::GzDecoder::new(file).take(HEAD_BYTES as u64).read_to_end(&mut head).ok()?;
        Some((head, u32::from_le_bytes(isize) as usize))
    } else {
        file.take(HEAD_BYTES as u64).read_to_end(&mut head).ok()?;
        Some((head, len as usize))
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

/// What `RedisStore::sweep_unknown` found.
#[cfg(feature = "bridge")]
#[derive(Debug, Default)]
pub struct RedisSweep {
    pub scanned: usize,
    /// Each key that went (or would, on a dry run) and its size in bytes.
    pub removed: Vec<(String, u64)>,
}

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
        self.run_sized(what, cmd, 0).await
    }

    /// `run`, for a command that moves `bytes` of payload: two seconds and one more per
    /// MiB, at most thirty. A flat two seconds timed out on every multi-megabyte body
    /// sent while a dozen others shared the connection — the SET was dropped (so Redis
    /// held a fraction of the cache) and the connection with it.
    async fn run_sized<T: redis::FromRedisValue>(&self, what: &str, cmd: redis::Cmd, bytes: usize) -> Option<T> {
        let mut c = self.conn().await?;
        let wait = std::time::Duration::from_millis((2_000 + (bytes as u64 >> 20) * 1_000).min(30_000));
        let lost = match tokio::time::timeout(wait, cmd.query_async::<T>(&mut c)).await {
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
        if self.run_sized::<()>("set", set, body.len()).await.is_none() {
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

    /// Housekeeping: delete the `elasticpro:ds:*` keys of clusters that are not in `keep`.
    ///
    /// Only keys of exactly the shape `elasticpro:ds:{cluster}:{dataset}` with a dataset this
    /// build knows are ever considered; anything else under the prefix is left alone. With
    /// `dry_run` nothing is deleted. Returns each key that went (or would), with its size in
    /// bytes, and how many keys were looked at; `Err` when Redis could not be scanned.
    pub async fn sweep_unknown(&self, keep: &HashSet<String>, dry_run: bool) -> Result<RedisSweep, String> {
        if self.client.is_none() {
            return Err("redis is not configured".into());
        }
        let mut cursor: u64 = 0;
        let mut keys: Vec<String> = vec![];
        loop {
            let mut scan = redis::cmd("SCAN");
            scan.arg(cursor).arg("MATCH").arg("elasticpro:ds:*").arg("COUNT").arg(500);
            let Some((next, batch)) = self.run::<(u64, Vec<String>)>("scan", scan).await else {
                return Err("redis could not be scanned".into());
            };
            keys.extend(batch);
            cursor = next;
            if cursor == 0 || keys.len() > 200_000 {
                break;
            }
        }
        let mut out = RedisSweep { scanned: keys.len(), removed: vec![] };
        for k in keys {
            let Some((cluster, ds)) = k.strip_prefix("elasticpro:ds:").and_then(|r| r.rsplit_once(':')) else { continue };
            if Dataset::parse(ds).is_none() || keep.contains(cluster) {
                continue;
            }
            let mut len = redis::cmd("STRLEN");
            len.arg(&k);
            let bytes = self.run::<u64>("strlen", len).await.unwrap_or(0);
            if !dry_run {
                let mut del = redis::cmd("DEL");
                del.arg(&k);
                if self.run::<i64>("del", del).await.is_none() {
                    return Err(format!("redis refused to delete {k}"));
                }
            }
            out.removed.push((k, bytes));
        }
        Ok(out)
    }

    /// Every entry Redis still holds, from `STRLEN` and the first few hundred bytes of
    /// each (`GETRANGE`) — no body is fetched, so deciding which ones are worth having
    /// costs nothing like holding them. (0.3.21 fetched and parsed every one into a list
    /// before looking at any, a second copy of the whole cache on top of the disk's, and
    /// that is what took it past its limit at every start.)
    pub async fn found(&self) -> Vec<Found> {
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
            let mut len = redis::cmd("STRLEN");
            len.arg(&k);
            let Some(bytes) = self.run::<usize>("strlen", len).await.filter(|n| *n > 0) else { continue };
            let mut head = redis::cmd("GETRANGE");
            head.arg(&k).arg(0).arg(HEAD_BYTES - 1);
            let Some(head) = self.run::<Vec<u8>>("getrange", head).await else { continue };
            let Some(fetched_at) = head_fetched_at(&head) else { continue };
            out.push(Found { cluster: cluster.to_string(), ds, fetched_at, bytes, at: Where::Redis(k) });
        }
        out
    }

    /// One found entry, fetched whole, as `restored`.
    pub async fn load(&self, f: &Found) -> Option<Entry> {
        let Where::Redis(k) = &f.at else { return None };
        let mut get = redis::cmd("GET");
        get.arg(k);
        let body = self.run_sized::<Option<Vec<u8>>>("get", get, f.bytes).await.flatten()?;
        restored(&body)
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
        e.data = Some(super::super::entry::Body::from_value(&data));
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

    #[test]
    fn finding_reads_the_head_and_the_size_not_the_body() {
        let dir = std::env::temp_dir().join(format!("elasticpro-found-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = DiskStore::new(Some(&dir));
        let big = ok_entry(json!({ "indices": { "json": "y".repeat(BIG_BYTES * 3) } }));
        let small = ok_entry(json!({ "health": { "json": {"status": "green"} } }));
        s.save("c1", Dataset::Indices, &big, 0);
        s.save("c1", Dataset::Health, &small, 0);
        let mut f = s.found();
        f.sort_by_key(|f| f.ds);
        assert_eq!(f.len(), 2);
        // The gzip trailer gives the decoded size of the big one; the small one is its file.
        assert_eq!(f[0].ds, Dataset::Health);
        assert_eq!(f[0].bytes, serde_json::to_vec(&small).unwrap().len());
        assert_eq!(f[1].ds, Dataset::Indices);
        assert_eq!(f[1].bytes, serde_json::to_vec(&big).unwrap().len());
        assert!(matches!(&f[1].at, Where::Disk { gz: true, .. }));
        assert!(f.iter().all(|f| f.fetched_at == Some(1000)));
        // And loading one gives exactly what was saved, as restored.
        let e = s.load(&f[1]).unwrap();
        assert_eq!(e.status, Status::Restored);
        assert_eq!(e.data.as_ref().unwrap().len(), big.data.as_ref().unwrap().len());
        assert!(f[1].cost() >= e.cost(), "the estimate never undercounts what loading costs");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetched_at_is_read_from_the_head() {
        assert_eq!(head_fetched_at(br#"{"status":"ok","fetchedAt":1712345678901,"attemptedAt":1}"#), Some(Some(1712345678901)));
        assert_eq!(head_fetched_at(br#"{"status":"ok","fetchedAt" : null,"x":1}"#), Some(None));
        assert_eq!(head_fetched_at(br#"{"status":"ok","fetchedAt":17123"#), None, "cut off: not an answer");
        assert_eq!(head_fetched_at(br#"{"status":"ok"}"#), None);
        assert_eq!(head_fetched_at(b"\xff\xfe garbage"), None);
        // What Entry really serialises.
        let e = ok_entry(json!({ "a": 1 }));
        let text = serde_json::to_vec(&e).unwrap();
        assert_eq!(head_fetched_at(&text[..HEAD_BYTES.min(text.len())]), Some(Some(1000)));
    }

    #[test]
    fn restore_order_is_health_then_background_then_on_demand_newest_first() {
        let f = |c: &str, ds, t| Found { cluster: c.into(), ds, fetched_at: t, bytes: 1, at: Where::Redis(String::new()) };
        let mut v = vec![
            f("a", Dataset::Indices, Some(50)),
            f("a", Dataset::Nodes, Some(10)),
            f("b", Dataset::Health, Some(1)),
            f("a", Dataset::Snapshots, Some(30)),
            f("b", Dataset::Shards, Some(90)),
            f("a", Dataset::Health, Some(5)),
            f("c", Dataset::Nodes, None),
        ];
        restore_order(&mut v);
        let got: Vec<(&str, Dataset)> = v.iter().map(|f| (f.cluster.as_str(), f.ds)).collect();
        assert_eq!(got, vec![
            ("a", Dataset::Health), ("b", Dataset::Health),
            ("a", Dataset::Snapshots), ("a", Dataset::Nodes), ("c", Dataset::Nodes),
            ("b", Dataset::Shards), ("a", Dataset::Indices),
        ]);
    }
}
