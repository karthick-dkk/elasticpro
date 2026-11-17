//! Health history for the Jobs page's Health and ElasticPro health cards (docs/HEALTH.md
//! "History", 0.3.77): the figures those cards show, kept on the server for 7 days — one point a
//! minute for the last 24 h, one every 10 minutes (the mean of its minutes) back to 7 days. About
//! 2,450 small rows, written to `<data>/health/history-<role>.json` (atomically) so a restart
//! keeps them.
//!
//! Pure apart from `load` / `save`: the minute task (`bridge/system_health.rs`) pushes a point,
//! `HEALTH_HISTORY` reads a range. Unknown is not zero: a figure that could not be read is `None`
//! in its point, left out of a 10-minute mean, and a mean of nothing is `None`.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

pub const MINUTE_MS: u64 = 60_000;
pub const TEN_MS: u64 = 10 * MINUTE_MS;
pub const DAY_MS: u64 = 24 * 60 * MINUTE_MS;
pub const WEEK_MS: u64 = 7 * DAY_MS;
/// At most this many minute points (a day, and a little slack for a clock step).
pub const MINUTE_KEEP: usize = 24 * 60 + 10;
/// At most this many 10-minute points (a week, and a little slack).
pub const TEN_KEEP: usize = 7 * 24 * 6 + 2;
/// Written every this many minutes (as the day's ring): a restart loses at most that.
pub const PERSIST_EVERY: u64 = 10;
const VERSION: u32 = 1;

/// The figures kept, in point order. The first five are the Health card's (Jobs strip), the rest
/// the ElasticPro health card's (the `SYSTEM_HEALTH` checks): one definition, read by both.
pub const FIELDS: &[&str] = &[
    "workerCpu", "coreCpu", "coreMem", "workerMem", "rps", "busy",
    "coreRss", "workerRss", "p95Ms", "refused", "latePct", "diskFreePct",
];
/// Fields an administrator alone reads (`SYSTEM_HEALTH` is an administrator's).
pub const ADMIN_FIELDS: &[&str] = &["coreRss", "workerRss", "p95Ms", "refused", "latePct", "diskFreePct"];
/// Fleet-wide counts a caller limited to some clusters does not read (they count the others).
pub const FLEET_FIELDS: &[&str] = &["rps", "busy"];

/// One point: when, and each of `FIELDS` (None = not known). Serialised as `[t, v0, v1, …]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub t: u64,
    pub v: Vec<Option<f64>>,
}

impl Point {
    pub fn new(t: u64) -> Point {
        Point { t, v: vec![None; FIELDS.len()] }
    }
    /// Set a field by name (an unknown name is a programming error, ignored in release).
    pub fn set(&mut self, field: &str, value: Option<f64>) {
        if let Some(i) = FIELDS.iter().position(|f| *f == field) {
            self.v[i] = value.filter(|x| x.is_finite());
        }
    }
    pub fn get(&self, field: &str) -> Option<f64> {
        FIELDS.iter().position(|f| *f == field).and_then(|i| self.v.get(i).copied().flatten())
    }
}

impl Serialize for Point {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = s.serialize_seq(Some(self.v.len() + 1))?;
        seq.serialize_element(&self.t)?;
        for v in &self.v {
            seq.serialize_element(v)?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for Point {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Point, D::Error> {
        let raw: Vec<Option<f64>> = Vec::deserialize(d)?;
        let t = raw.first().copied().flatten().filter(|t| *t >= 0.0).ok_or_else(|| serde::de::Error::custom("a point without a time"))? as u64;
        // A file from a release with fewer or more fields: what is missing is not known.
        let mut v: Vec<Option<f64>> = raw.into_iter().skip(1).take(FIELDS.len()).collect();
        v.resize(FIELDS.len(), None);
        Ok(Point { t, v })
    }
}

/// The 10-minute bucket being filled: its start, and per field the sum and count of known values.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Acc {
    pub bucket: u64,
    pub sums: Vec<f64>,
    pub counts: Vec<u32>,
}

impl Acc {
    fn start(bucket: u64) -> Acc {
        Acc { bucket, sums: vec![0.0; FIELDS.len()], counts: vec![0; FIELDS.len()] }
    }
    fn add(&mut self, p: &Point) {
        self.sums.resize(FIELDS.len(), 0.0);
        self.counts.resize(FIELDS.len(), 0);
        for (i, v) in p.v.iter().enumerate() {
            if let Some(x) = v {
                self.sums[i] += x;
                self.counts[i] += 1;
            }
        }
    }
    /// The mean of the bucket's minutes, stamped at the bucket's start; a field never known is None.
    fn mean(&self) -> Point {
        let v = (0..FIELDS.len())
            .map(|i| match (self.sums.get(i), self.counts.get(i)) {
                (Some(s), Some(&n)) if n > 0 => Some(s / n as f64),
                _ => None,
            })
            .collect();
        Point { t: self.bucket, v }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    #[serde(default)]
    pub minute: VecDeque<Point>,
    #[serde(default)]
    pub ten: VecDeque<Point>,
    #[serde(default)]
    pub acc: Option<Acc>,
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    role: String,
    fields: Vec<String>,
    #[serde(flatten)]
    history: History,
}

/// The ranges `HEALTH_HISTORY` answers, and the span of each.
pub fn range_ms(range: &str) -> Option<u64> {
    match range {
        "1h" => Some(60 * MINUTE_MS),
        "6h" => Some(6 * 60 * MINUTE_MS),
        "24h" => Some(DAY_MS),
        "7d" => Some(WEEK_MS),
        _ => None,
    }
}

impl History {
    /// One minute's point. A point not after the last one (a clock stepped back, a second sample
    /// in the same minute) is dropped: the lines never go backwards.
    pub fn push(&mut self, p: Point) {
        if self.minute.back().is_some_and(|l| p.t <= l.t) {
            return;
        }
        let bucket = p.t - p.t % TEN_MS;
        match self.acc.as_mut() {
            Some(a) if a.bucket == bucket => a.add(&p),
            _ => {
                if let Some(done) = self.acc.take() {
                    self.ten.push_back(done.mean());
                }
                let mut a = Acc::start(bucket);
                a.add(&p);
                self.acc = Some(a);
            }
        }
        let now = p.t;
        self.minute.push_back(p);
        self.trim(now);
    }

    fn trim(&mut self, now: u64) {
        while self.minute.front().is_some_and(|f| now.saturating_sub(f.t) > DAY_MS) || self.minute.len() > MINUTE_KEEP {
            self.minute.pop_front();
        }
        while self.ten.front().is_some_and(|f| now.saturating_sub(f.t) > WEEK_MS) || self.ten.len() > TEN_KEEP {
            self.ten.pop_front();
        }
    }

    /// The points of a range ending at `now`, oldest first, and their step: minute points for
    /// 1h / 6h / 24h, 10-minute means for 7d (the bucket being filled included, as its mean so far).
    pub fn read(&self, range: &str, now: u64) -> Option<(u64, Vec<Point>)> {
        let span = range_ms(range)?;
        let from = now.saturating_sub(span);
        let keep = |p: &&Point| p.t >= from && p.t <= now;
        if span <= DAY_MS {
            return Some((MINUTE_MS, self.minute.iter().filter(keep).cloned().collect()));
        }
        let mut out: Vec<Point> = self.ten.iter().filter(keep).cloned().collect();
        if let Some(a) = self.acc.as_ref().map(Acc::mean).filter(|p| p.t >= from && p.t <= now) {
            out.push(a);
        }
        Some((TEN_MS, out))
    }

    pub fn path(data: &Path, role: &str) -> PathBuf {
        data.join(crate::health::HEALTH_DIR).join(format!("history-{role}.json"))
    }

    pub fn to_json(&self, role: &str) -> Vec<u8> {
        serde_json::to_vec(&File { version: VERSION, role: role.to_string(), fields: FIELDS.iter().map(|s| s.to_string()).collect(), history: self.clone() })
            .unwrap_or_default()
    }

    /// From its file: what is in the future or older than its tier is dropped; a file that does
    /// not parse is an empty history (nothing is invented).
    pub fn from_json(bytes: &[u8], now: u64) -> History {
        let Ok(f) = serde_json::from_slice::<File>(bytes) else { return History::default() };
        // A file whose fields are in another order cannot be read point by point: start again.
        if f.fields.iter().zip(FIELDS).any(|(a, b)| a != b) {
            return History::default();
        }
        let mut h = f.history;
        h.minute.retain(|p| p.t <= now);
        h.ten.retain(|p| p.t <= now);
        if h.acc.as_ref().is_some_and(|a| a.bucket > now) {
            h.acc = None;
        }
        h.trim(now);
        h
    }

    pub fn load(data: &Path, role: &str, now: u64) -> History {
        std::fs::read(History::path(data, role)).map(|b| History::from_json(&b, now)).unwrap_or_default()
    }

    pub fn save(&self, data: &Path, role: &str) -> Result<(), String> {
        crate::volume::store::write_atomic(&History::path(data, role), &self.to_json(role))
    }

    /// Rows held, both tiers.
    pub fn len(&self) -> usize {
        self.minute.len() + self.ten.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The fields a caller reads: an administrator every one; anybody else not the administrator's
/// (`ADMIN_FIELDS`), and a caller limited to some clusters not the fleet-wide counts.
pub fn fields_for(admin: bool, limited: bool) -> Vec<&'static str> {
    FIELDS.iter().copied()
        .filter(|f| admin || !ADMIN_FIELDS.contains(f))
        .filter(|f| !limited || !FLEET_FIELDS.contains(f))
        .collect()
}

/// Points narrowed to `fields`, as `[t, …]` rows in that order.
pub fn rows(points: &[Point], fields: &[&str]) -> Vec<Vec<Option<f64>>> {
    points.iter().map(|p| {
        let mut row = vec![Some(p.t as f64)];
        row.extend(fields.iter().map(|f| p.get(f)));
        row
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_793_952_000_000; // a whole 10 minutes

    fn pt(t: u64, cpu: Option<f64>) -> Point {
        let mut p = Point::new(t);
        p.set("coreCpu", cpu);
        p.set("busy", Some(1.0));
        p
    }

    #[test]
    fn ten_minute_means_leave_unknown_out() {
        let mut h = History::default();
        for i in 0..10 {
            h.push(pt(T0 + i * MINUTE_MS, if i % 2 == 0 { Some(10.0 * i as f64) } else { None }));
        }
        assert!(h.ten.is_empty(), "the first bucket is still being filled");
        h.push(pt(T0 + 10 * MINUTE_MS, Some(5.0)));
        assert_eq!(h.ten.len(), 1);
        let m = &h.ten[0];
        assert_eq!(m.t, T0);
        // 0, 20, 40, 60, 80 known (5 of the 10 minutes): mean 40, the unknown minutes left out, never 0.
        assert_eq!(m.get("coreCpu"), Some(40.0));
        assert_eq!(m.get("busy"), Some(1.0));
        assert_eq!(m.get("rps"), None, "never known in the bucket: not known, not 0");
    }

    #[test]
    fn bounded_to_a_day_of_minutes_and_a_week_of_ten_minutes() {
        let mut h = History::default();
        let n = 9 * 24 * 60; // nine days of minutes
        for i in 0..n {
            h.push(pt(T0 + i * MINUTE_MS, Some(1.0)));
        }
        assert!(h.minute.len() <= MINUTE_KEEP, "{}", h.minute.len());
        assert!(h.ten.len() <= TEN_KEEP, "{}", h.ten.len());
        let now = T0 + (n - 1) * MINUTE_MS;
        assert!(now - h.minute.front().unwrap().t <= DAY_MS);
        assert!(now - h.ten.front().unwrap().t <= WEEK_MS);
        assert!(h.len() < 2_500, "about 2,450 rows at most: {}", h.len());
    }

    #[test]
    fn a_point_not_after_the_last_is_dropped() {
        let mut h = History::default();
        h.push(pt(T0 + MINUTE_MS, Some(1.0)));
        h.push(pt(T0 + MINUTE_MS, Some(2.0)));
        h.push(pt(T0, Some(3.0)));
        assert_eq!(h.minute.len(), 1);
        assert_eq!(h.minute[0].get("coreCpu"), Some(1.0));
    }

    #[test]
    fn ranges_read_their_tier() {
        let mut h = History::default();
        for i in 0..(2 * 24 * 60) {
            h.push(pt(T0 + i * MINUTE_MS, Some(i as f64)));
        }
        let now = T0 + (2 * 24 * 60 - 1) * MINUTE_MS;
        let (step, one) = h.read("1h", now).unwrap();
        assert_eq!(step, MINUTE_MS);
        assert_eq!(one.len(), 61);
        let (_, day) = h.read("24h", now).unwrap();
        assert!(day.len() >= 1440 && day.len() <= 1441, "{}", day.len());
        let (step, week) = h.read("7d", now).unwrap();
        assert_eq!(step, TEN_MS);
        assert_eq!(week.len(), 2 * 24 * 6, "the finished buckets and the one being filled");
        assert!(week.windows(2).all(|w| w[0].t < w[1].t));
        assert!(h.read("2h", now).is_none(), "a range it does not offer");
    }

    #[test]
    fn kept_across_a_restart_and_a_bad_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("ep-hh-{}", crate::auth::random_hex(6)));
        let mut h = History::default();
        for i in 0..25 {
            h.push(pt(T0 + i * MINUTE_MS, Some(i as f64)));
        }
        h.save(&dir, "all").unwrap();
        let back = History::load(&dir, "all", T0 + 25 * MINUTE_MS);
        assert_eq!(back, h);
        // Read later, what fell out of its tier is gone.
        let later = History::load(&dir, "all", T0 + 2 * DAY_MS);
        assert!(later.minute.is_empty());
        assert_eq!(later.ten.len(), 2);
        std::fs::write(History::path(&dir, "all"), b"{not json").unwrap();
        assert!(History::load(&dir, "all", T0).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fields_by_who_reads() {
        assert_eq!(fields_for(true, false).len(), FIELDS.len());
        let user = fields_for(false, false);
        assert!(user.contains(&"coreCpu") && user.contains(&"rps") && !user.contains(&"p95Ms"));
        let limited = fields_for(false, true);
        assert!(!limited.contains(&"rps") && !limited.contains(&"busy") && limited.contains(&"workerCpu"));
        let mut p = pt(T0, Some(7.0));
        p.set("rps", Some(0.5));
        assert_eq!(rows(&[p], &["coreCpu", "rps"]), vec![vec![Some(T0 as f64), Some(7.0), Some(0.5)]]);
    }

    #[test]
    fn a_point_serialises_as_an_array() {
        let p = pt(T0, Some(2.5));
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.starts_with(&format!("[{T0},")), "{s}");
        let back: Point = serde_json::from_str(&s).unwrap();
        assert_eq!(back, p);
        // A shorter row (an older release) reads what it has; the rest is not known.
        let short: Point = serde_json::from_str(&format!("[{T0}, 1.0]")).unwrap();
        assert_eq!(short.v.len(), FIELDS.len());
        assert_eq!(short.get("workerCpu"), Some(1.0));
        assert_eq!(short.get("diskFreePct"), None);
    }
}
