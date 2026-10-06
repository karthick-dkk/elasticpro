//! Notification history, kept by the core rather than one browser.
//!
//! The bell used to hold the last fifty notices in `localStorage`, which meant a restore
//! finished at night was in the history of whichever browser happened to start it and
//! nowhere else. This keeps the same records server-side, per person, for a fixed number
//! of days (`ELASTICPRO_NOTIFY_DAYS`, default 30).
//!
//! It is not a write to anything but this file: no cluster is touched, so it is not gated
//! by the write guard. It is gated by identity instead — every call names the caller's own
//! user, and nothing here takes a user from the message, so nobody can read or clear
//! somebody else's history.
//!
//! One record per `(user, id)`. A long task sends its "running" record and later its
//! "finished" record under the same id, and that stays one entry.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Days a notification is kept. The one definition; the env var only overrides it.
pub const DEFAULT_RETENTION_DAYS: u64 = 30;
/// Newest records kept per person, whatever their age.
pub const MAX_PER_USER: usize = 2000;
/// How long a change may sit in memory before it is written out.
const DEBOUNCE_MS: u64 = 750;

/// The kinds the bell knows how to draw.
pub const KINDS: [&str; 4] = ["ok", "err", "warn", "run"];

const MAX_ID: usize = 128;
const MAX_MESSAGE: usize = 2000;
const MAX_DETAIL_LINES: usize = 40;
const MAX_DETAIL_LINE: usize = 1000;
const MAX_META: usize = 500;
const MAX_CLUSTER: usize = 200;
/// Default and largest page NOTIFY_LIST returns.
pub const LIST_DEFAULT: usize = 100;
pub const LIST_MAX: usize = 500;

const DAY_MS: u64 = 86_400_000;

/// Retention in days: `ELASTICPRO_NOTIFY_DAYS` when it is a number from 1 to 3650, else 30.
pub fn retention_days() -> u64 {
    std::env::var("ELASTICPRO_NOTIFY_DAYS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|d| (1..=3650).contains(d))
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub user: String,
    pub message: String,
    pub kind: String,
    #[serde(default)]
    pub detail: Vec<String>,
    #[serde(default)]
    pub meta: String,
    /// The cluster id it is about, if any. A scoped caller stops seeing it when the
    /// cluster stops being theirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    /// When it happened, by the browser's clock (ms). Clamped to "not in the future".
    pub at: u64,
    /// When this core last changed it (ms).
    pub updated_at: u64,
}

impl Record {
    /// The record as the UI receives it: the user is implicit — it is always the caller.
    pub fn public(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        if let Some(m) = v.as_object_mut() {
            m.remove("user");
        }
        v
    }
}

#[derive(Serialize, Deserialize, Default)]
struct FileShape {
    #[serde(default)]
    records: Vec<Record>,
}

struct Inner {
    path: Option<PathBuf>,
    retention_ms: u64,
    records: Mutex<Vec<Record>>,
    dirty: AtomicBool,
    flush_pending: AtomicBool,
    writing: Mutex<()>,
}

/// The store. Cheap to clone; clones share one history.
#[derive(Clone)]
pub struct NotifyStore {
    inner: Arc<Inner>,
    days: u64,
}

fn now_ms() -> u64 {
    crate::fleet::now_ms()
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

impl NotifyStore {
    /// `path`: the file to keep them in, or `None` for this process only. Retention comes
    /// from `retention_days()`.
    pub fn open(path: Option<PathBuf>) -> NotifyStore {
        NotifyStore::open_with_days(path, retention_days())
    }

    pub fn open_with_days(path: Option<PathBuf>, days: u64) -> NotifyStore {
        let records = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<FileShape>(&b).ok())
            .map(|f| f.records)
            .unwrap_or_default();
        let store = NotifyStore {
            inner: Arc::new(Inner {
                path,
                retention_ms: days.saturating_mul(DAY_MS),
                records: Mutex::new(records),
                dirty: AtomicBool::new(false),
                flush_pending: AtomicBool::new(false),
                writing: Mutex::new(()),
            }),
            days,
        };
        // Pruned on load: an app that was off for a month comes back with nothing stale.
        let before = store.inner.records.lock().len();
        store.inner.prune(now_ms());
        if store.inner.records.lock().len() != before {
            store.changed();
        }
        store
    }

    /// Days kept.
    pub fn days(&self) -> u64 {
        self.days
    }

    /// Add or update the caller's record. Returns its id.
    pub fn put(&self, user: &str, msg: &serde_json::Value) -> Result<String, String> {
        let s = |k: &str| msg.get(k).and_then(|v| v.as_str());
        let message = s("message").map(str::trim).unwrap_or("");
        if message.is_empty() {
            return Err("message is required".into());
        }
        if message.chars().count() > MAX_MESSAGE {
            return Err(format!("message is longer than {MAX_MESSAGE} characters"));
        }
        let kind = s("kind").unwrap_or("");
        if !KINDS.contains(&kind) {
            return Err(format!("kind must be one of {}", KINDS.join(", ")));
        }
        let id = match msg.get("id") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(v)) if valid_id(v) => Some(v.clone()),
            Some(_) => {
                return Err(format!("id must be 1–{MAX_ID} characters of letters, digits and - _ . :"));
            }
        };
        let detail = match msg.get("detail") {
            None | Some(serde_json::Value::Null) => vec![],
            Some(serde_json::Value::Array(a)) => {
                if a.len() > MAX_DETAIL_LINES {
                    return Err(format!("detail has more than {MAX_DETAIL_LINES} lines"));
                }
                let mut out = Vec::with_capacity(a.len());
                for x in a {
                    let Some(line) = x.as_str() else { return Err("detail must be a list of strings".into()) };
                    out.push(clip(line, MAX_DETAIL_LINE));
                }
                out
            }
            Some(_) => return Err("detail must be a list of strings".into()),
        };
        let meta = match msg.get("meta") {
            None | Some(serde_json::Value::Null) => String::new(),
            Some(serde_json::Value::String(v)) => clip(v, MAX_META),
            Some(_) => return Err("meta must be a string".into()),
        };
        let cluster = match msg.get("cluster") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(v)) if !v.is_empty() => Some(clip(v, MAX_CLUSTER)),
            Some(serde_json::Value::String(_)) => None,
            Some(_) => return Err("cluster must be a string".into()),
        };
        let now = now_ms();
        let at = match msg.get("at") {
            None | Some(serde_json::Value::Null) => now,
            Some(v) => match v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)) {
                Some(t) => t.min(now),
                None => return Err("at must be a time in milliseconds".into()),
            },
        };
        let id = id.unwrap_or_else(|| format!("n-{now}-{:08x}", rand::random::<u32>()));

        {
            let mut recs = self.inner.records.lock();
            let rec = Record {
                id: id.clone(),
                user: user.to_string(),
                message: message.to_string(),
                kind: kind.to_string(),
                detail,
                meta,
                cluster,
                at,
                updated_at: now,
            };
            match recs.iter_mut().find(|r| r.user == user && r.id == id) {
                Some(r) => *r = rec,
                None => recs.push(rec),
            }
        }
        self.inner.prune(now);
        self.changed();
        Ok(id)
    }

    /// The caller's records, newest first.
    ///
    /// `since`: only records this core changed after it (ms). `before`: only records that
    /// happened before it (ms) — the "load more" cursor. `visible`: the cluster ids the
    /// caller may see, or `None` for all of them; a record about a cluster outside it is
    /// left out, a record about no cluster never is. Returns the page and whether there is
    /// more past it.
    pub fn list(
        &self,
        user: &str,
        since: Option<u64>,
        before: Option<u64>,
        limit: usize,
        visible: Option<&std::collections::HashSet<String>>,
    ) -> (Vec<Record>, bool) {
        let cutoff = now_ms().saturating_sub(self.inner.retention_ms);
        let mut mine: Vec<Record> = self
            .inner
            .records
            .lock()
            .iter()
            .filter(|r| r.user == user && r.at >= cutoff)
            .filter(|r| since.is_none_or(|s| r.updated_at > s))
            .filter(|r| before.is_none_or(|b| r.at < b))
            .filter(|r| match (&r.cluster, visible) {
                (Some(c), Some(v)) => v.contains(c),
                _ => true,
            })
            .cloned()
            .collect();
        mine.sort_by(|a, b| b.at.cmp(&a.at).then(b.updated_at.cmp(&a.updated_at)).then(b.id.cmp(&a.id)));
        let limit = limit.clamp(1, LIST_MAX);
        let more = mine.len() > limit;
        mine.truncate(limit);
        (mine, more)
    }

    /// Remove every record of the caller's. Returns how many went.
    pub fn clear(&self, user: &str) -> usize {
        let n = {
            let mut recs = self.inner.records.lock();
            let before = recs.len();
            recs.retain(|r| r.user != user);
            before - recs.len()
        };
        if n > 0 {
            self.changed();
        }
        n
    }

    /// Write out now whatever is waiting for the debounce.
    pub fn flush(&self) {
        self.inner.flush();
    }

    fn changed(&self) {
        self.inner.dirty.store(true, Ordering::SeqCst);
        if self.inner.path.is_none() || self.inner.flush_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                let inner = self.inner.clone();
                h.spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(DEBOUNCE_MS)).await;
                    inner.flush_pending.store(false, Ordering::SeqCst);
                    let _ = tokio::task::spawn_blocking(move || inner.flush()).await;
                });
            }
            Err(_) => {
                self.inner.flush_pending.store(false, Ordering::SeqCst);
                self.inner.flush();
            }
        }
    }
}

impl Inner {
    /// Older than the retention goes; past the per-person cap, the oldest go.
    fn prune(&self, now: u64) {
        let cutoff = now.saturating_sub(self.retention_ms);
        let mut recs = self.records.lock();
        recs.retain(|r| r.at >= cutoff);
        let mut per: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for r in recs.iter() {
            *per.entry(r.user.as_str()).or_default() += 1;
        }
        let over: Vec<String> = per.into_iter().filter(|(_, n)| *n > MAX_PER_USER).map(|(u, _)| u.to_string()).collect();
        for u in over {
            let mut order: Vec<usize> = (0..recs.len()).filter(|&i| recs[i].user == u).collect();
            order.sort_by(|&a, &b| recs[b].at.cmp(&recs[a].at).then(recs[b].updated_at.cmp(&recs[a].updated_at)));
            let mut keep = vec![true; recs.len()];
            for &i in &order[MAX_PER_USER..] {
                keep[i] = false;
            }
            let mut idx = 0;
            recs.retain(|_| {
                let k = keep[idx];
                idx += 1;
                k
            });
        }
    }

    fn flush(&self) {
        let Some(path) = &self.path else { return };
        let _w = self.writing.lock();
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let body = {
            let recs = self.records.lock();
            serde_json::to_vec(&serde_json::json!({ "version": 1, "records": &*recs }))
        };
        let Ok(body) = body else { return };
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &body) {
            tracing::warn!(error = %e, "could not write the notification history");
            self.dirty.store(true, Ordering::SeqCst);
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        if let Err(e) = std::fs::rename(&tmp, path) {
            tracing::warn!(error = %e, "could not replace the notification history");
            self.dirty.store(true, Ordering::SeqCst);
        }
    }
}

impl Drop for Inner {
    /// Whatever the debounce was still holding is written on the way out.
    fn drop(&mut self) {
        self.flush();
    }
}
