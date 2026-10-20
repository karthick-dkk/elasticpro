//! Asking a cluster once for what several people want at the same moment.
//!
//! Two pieces, both for a person's reads only (the poller keeps its own per-dataset
//! dedupe, and a write is never anybody else's business):
//!
//! * [`Flights`] — single-flight. The first request for a key goes to the cluster as its
//!   own task; anyone asking the same while it is on its way waits for that answer instead
//!   of sending another. Each waiter keeps its own timeout and its own abort; the task is
//!   cancelled only when the last of them has gone.
//! * [`ReadCache`] — the answer kept for a few seconds (ES_READ_CACHE_SECONDS), so ten
//!   tabs opening the same page in the same second is one request, bounded in bytes and
//!   emptied for a cluster the moment anything is written to it.
//!
//! The key is everything that decides the answer: cluster, the URL it resolved to, method,
//! path, body and the credential it goes with. Two people share an answer only when the
//! core would have sent the very same request on behalf of each — and each of them has
//! already been through the gate that decides whether they may see that cluster.

use parking_lot::Mutex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub type Key = [u8; 32];

/// The identity of a request, as a digest: long bodies and credentials are never kept.
pub fn key(cluster: &str, url: &str, method: &str, path: &str, body: Option<&str>, credential: Option<&str>) -> Key {
    let mut h = Sha256::new();
    for part in [Some(cluster), Some(url.trim_end_matches('/')), Some(&method.to_ascii_uppercase()), Some(path), body, credential] {
        match part {
            Some(p) => {
                h.update([1u8]);
                h.update((p.len() as u64).to_le_bytes());
                h.update(p.as_bytes());
            }
            None => h.update([0u8]),
        }
    }
    h.finalize().into()
}

/* ------------------------------------- single-flight ------------------------------------- */

pub type Answer = Option<Arc<Value>>;

struct Flight {
    tx: watch::Sender<Answer>,
    waiters: usize,
    task: Option<tokio::task::AbortHandle>,
    /// The record number of the request on its way — which flight this is.
    leader: u64,
}

/// What joining a key gave you.
pub struct Joined {
    pub rx: watch::Receiver<Answer>,
    /// The record number of the request that is on its way to the cluster.
    pub leader: u64,
    /// False for the one who started it.
    pub follower: bool,
}

#[derive(Default)]
pub struct Flights {
    map: Mutex<HashMap<Key, Flight>>,
}

impl Flights {
    /// Wait for the request already on its way for this key, or start it as `leader` (its
    /// record number): `start` is called — under this lock, so nobody else starts the same
    /// one — with the sender the task publishes on, and returns the task's handle. It must
    /// not take any other lock.
    pub fn join_or_start(&self, key: Key, leader: u64, start: impl FnOnce(watch::Sender<Answer>) -> tokio::task::AbortHandle) -> Joined {
        let mut m = self.map.lock();
        if let Some(f) = m.get_mut(&key) {
            f.waiters += 1;
            return Joined { rx: f.tx.subscribe(), leader: f.leader, follower: true };
        }
        let (tx, rx) = watch::channel(None);
        let task = start(tx.clone());
        m.insert(key, Flight { tx, waiters: 1, task: Some(task), leader });
        Joined { rx, leader, follower: false }
    }

    /// A waiter is gone. The last one out cancels the request — returns true when that
    /// happened.
    pub fn leave(&self, key: &Key, leader: u64) -> bool {
        let mut m = self.map.lock();
        let Some(f) = m.get_mut(key).filter(|f| f.leader == leader) else { return false };
        f.waiters -= 1;
        if f.waiters > 0 {
            return false;
        }
        if let Some(t) = f.task.take() {
            t.abort();
        }
        m.remove(key);
        true
    }

    /// The task has published its answer: later askers start afresh (or find the cache).
    pub fn done(&self, key: &Key, leader: u64) {
        let mut m = self.map.lock();
        if m.get(key).is_some_and(|f| f.leader == leader) {
            m.remove(key);
        }
    }

    pub fn len(&self) -> usize {
        self.map.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A seat in a flight: leaving it — however the waiter's future ends — is `Flights::leave`.
pub struct Seat {
    flights: Arc<Flights>,
    key: Key,
    leader: u64,
    armed: bool,
}

impl Seat {
    pub fn new(flights: Arc<Flights>, key: Key, leader: u64) -> Seat {
        Seat { flights, key, leader, armed: true }
    }

    /// Leave now; true when this was the last waiter and the request was cancelled.
    pub fn leave(mut self) -> bool {
        self.armed = false;
        self.flights.leave(&self.key, self.leader)
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        if self.armed {
            self.flights.leave(&self.key, self.leader);
        }
    }
}

/* -------------------------------------- read cache -------------------------------------- */

struct Entry {
    value: Arc<Value>,
    at: Instant,
    bytes: u64,
    cluster: String,
    tick: u64,
}

#[derive(Default)]
struct CacheInner {
    map: HashMap<Key, Entry>,
    /// Least recently used first.
    order: BTreeMap<u64, Key>,
    bytes: u64,
    tick: u64,
}

impl CacheInner {
    fn remove(&mut self, k: &Key) {
        if let Some(e) = self.map.remove(k) {
            self.order.remove(&e.tick);
            self.bytes -= e.bytes;
        }
    }
}

/// Answers kept for a few seconds, least recently used out first.
#[derive(Default)]
pub struct ReadCache {
    inner: Mutex<CacheInner>,
}

impl ReadCache {
    /// The answer for this key if it is younger than `max_age`, and how old it is.
    pub fn get(&self, k: &Key, max_age: Duration) -> Option<(Arc<Value>, u64)> {
        let mut c = self.inner.lock();
        let age = c.map.get(k)?.at.elapsed();
        if age > max_age {
            return None;
        }
        c.tick += 1;
        let tick = c.tick;
        let e = c.map.get_mut(k)?;
        let old = std::mem::replace(&mut e.tick, tick);
        let v = e.value.clone();
        c.order.remove(&old);
        c.order.insert(tick, *k);
        Some((v, age.as_millis() as u64))
    }

    /// Keep an answer, within `cap` bytes overall. One larger than the whole cap is not kept.
    pub fn put(&self, k: Key, cluster: &str, value: Arc<Value>, bytes: u64, cap: u64) {
        if bytes > cap || cap == 0 {
            return;
        }
        let mut c = self.inner.lock();
        c.remove(&k);
        while c.bytes + bytes > cap {
            let Some((_, oldest)) = c.order.pop_first() else { break };
            if let Some(e) = c.map.remove(&oldest) {
                c.bytes -= e.bytes;
            }
        }
        c.tick += 1;
        let tick = c.tick;
        c.order.insert(tick, k);
        c.bytes += bytes;
        c.map.insert(k, Entry { value, at: Instant::now(), bytes, cluster: cluster.to_string(), tick });
    }

    /// Something was written to this cluster: nothing kept for it is to be trusted.
    pub fn drop_cluster(&self, cluster: &str) {
        let mut c = self.inner.lock();
        let gone: Vec<Key> = c.map.iter().filter(|(_, e)| e.cluster == cluster).map(|(k, _)| *k).collect();
        for k in gone {
            c.remove(&k);
        }
    }

    pub fn clear(&self) {
        *self.inner.lock() = CacheInner::default();
    }

    /// Drop what has aged past `max_age`, so an idle cache holds nothing.
    pub fn prune(&self, max_age: Duration) {
        let mut c = self.inner.lock();
        let gone: Vec<Key> = c.map.iter().filter(|(_, e)| e.at.elapsed() > max_age).map(|(k, _)| *k).collect();
        for k in gone {
            c.remove(&k);
        }
    }

    /// (entries, bytes)
    pub fn usage(&self) -> (usize, u64) {
        let c = self.inner.lock();
        (c.map.len(), c.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_key_covers_everything_that_decides_the_answer() {
        let base = key("c", "http://h:9200/", "get", "/_cat/indices", None, Some("Basic x"));
        assert_eq!(base, key("c", "http://h:9200", "GET", "/_cat/indices", None, Some("Basic x")), "a trailing slash and the method's case do not matter");
        assert_ne!(base, key("c", "http://h:9200", "GET", "/_cat/indices", None, Some("Basic y")), "another credential is another request");
        assert_ne!(base, key("c", "http://h:9200", "GET", "/_cat/indices", None, None));
        assert_ne!(base, key("d", "http://h:9200", "GET", "/_cat/indices", None, Some("Basic x")));
        assert_ne!(key("c", "u", "POST", "/_search", Some("{}"), None), key("c", "u", "POST", "/_search", Some("{ }"), None));
        assert_ne!(key("c", "u", "GET", "/ab", None, None), key("c", "u", "GET", "/a", Some("b"), None), "parts cannot run into each other");
    }

    #[test]
    fn the_cache_ages_out_evicts_least_recent_and_forgets_a_written_cluster() {
        let c = ReadCache::default();
        let (a, b, d) = (key("x", "u", "GET", "/a", None, None), key("x", "u", "GET", "/b", None, None), key("y", "u", "GET", "/d", None, None));
        c.put(a, "x", Arc::new(json!(1)), 40, 100);
        c.put(b, "x", Arc::new(json!(2)), 40, 100);
        assert!(c.get(&a, Duration::from_secs(5)).is_some(), "a is now the most recent");
        c.put(d, "y", Arc::new(json!(3)), 40, 100);
        assert!(c.get(&b, Duration::from_secs(5)).is_none(), "b was least recently used and made room");
        assert_eq!(c.usage(), (2, 80));
        c.drop_cluster("x");
        assert!(c.get(&a, Duration::from_secs(5)).is_none());
        assert!(c.get(&d, Duration::from_secs(5)).is_some(), "another cluster's answer stays");
        assert!(c.get(&d, Duration::ZERO).is_none() || c.get(&d, Duration::ZERO).is_some_and(|(_, age)| age == 0), "max age 0 accepts only an answer from this very millisecond");
        c.put(a, "x", Arc::new(json!(4)), 101, 100);
        assert!(c.get(&a, Duration::from_secs(5)).is_none(), "larger than the whole cache: not kept");
        c.prune(Duration::ZERO);
        std::thread::sleep(Duration::from_millis(2));
        c.prune(Duration::from_millis(1));
        assert_eq!(c.usage(), (0, 0));
    }

    #[tokio::test]
    async fn the_last_waiter_out_cancels_the_request_and_not_before() {
        let f = Arc::new(Flights::default());
        let k = key("c", "u", "GET", "/", None, None);
        let started = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let s2 = started.clone();
        let j1 = f.join_or_start(k, 7, move |_tx| {
            s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let h = tokio::spawn(async { tokio::time::sleep(Duration::from_secs(30)).await });
            h.abort_handle()
        });
        let j2 = f.join_or_start(k, 8, |_| unreachable!("a second request for the same key is never started"));
        assert!(!j1.follower && j2.follower && j2.leader == 7);
        assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 1);
        let (s1, s2) = (Seat::new(f.clone(), k, 7), Seat::new(f.clone(), k, 7));
        assert!(!s1.leave(), "one is still waiting");
        assert_eq!(f.len(), 1);
        drop(s2);
        assert!(f.is_empty(), "the last one out cancelled it");
    }
}
