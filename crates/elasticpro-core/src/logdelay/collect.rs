//! One cluster's devices, read page by page (docs/LOGDELAY.md "Measurement"): the one query
//! path of every log delay measurement — the timer's, `DELAY_SINK_RUN`, and *Fetch now*
//! (`JOB_RUN {jobId: "logdelay.measure", clusterIds?, device?}`).
//!
//! ```text
//!   page_body(after = None) ──▶ es_req ──▶ read_page ──▶ readings += page   (the answer dropped)
//!        ▲                                   │
//!        └──────── after_key, size ◀─────────┘ until a short page, the device cap, a failure
//! ```
//!
//! * **Nothing truncated by the query.** A composite aggregation has no bucket limit of its
//!   own: every device of the window comes back, a page at a time, in device-name order. The
//!   only bound is *Max devices per run* (`SinkConfig::max_devices`, at most
//!   `measure::MAX_DEVICES_PER_RUN`), and reaching it is said (`truncated`), never hidden.
//! * **Memory.** One page's answer is held at a time; its readings are kept and the answer is
//!   dropped. A page whose answer is larger than `memory::report_page_bytes` makes the next
//!   ones half the size; an answer over the response cap (`response_too_large`) is asked
//!   again at half the size.
//! * **A failed page is not the end of the list.** Shards that failed or a time-out are asked
//!   again (twice); after that the run keeps what it read and says the list is incomplete, so
//!   nobody it did not read is turned silent (`Tracker::apply_run`, `complete: false`).

use super::measure::{self, DeviceFilter, Fields, LogTypeField, PageError, Reading};
use crate::bridge::Core;
use crate::http::EsRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// Tries of one page (the first and two more) before the run keeps what it has.
pub const PAGE_TRIES: u32 = 3;
/// One page's time limit. A page is a thousand devices' newest documents: heavier than the
/// one-aggregation search was per request, lighter in total.
pub const PAGE_TIMEOUT_MS: u64 = 120_000;

/// What one cluster's read gave.
#[derive(Debug, Default)]
pub struct Collected {
    pub readings: Vec<Reading>,
    pub pages: u64,
    /// Every device of the window was read (the last page came back short).
    pub complete: bool,
    /// *Max devices per run* was reached with more devices to read.
    pub truncated: bool,
    /// Documents in the window that carry no device name (in no bucket).
    pub no_device: Option<u64>,
    /// Why the read stopped early, when it did (a failed page, a cancel, an odd answer).
    pub error: Option<String>,
    /// The largest page answer, bytes.
    pub largest_page_bytes: u64,
    /// The log type field this run read by, or why it read none.
    pub log_type: LogTypeField,
    /// Where the next run begins (`Walk`).
    pub types_after: Option<Value>,
}

/// The order a run reads its devices in, and how many of them by log types. All of them are read,
/// once; their log types up to a limit (`measure::TYPES_PER_RUN`), and where that was reached the
/// next run begins, so that no device is always past it: from there to the last name, then from the
/// first name to there.
#[derive(Debug, Default)]
struct Walk {
    start: Option<Value>,
    limit: usize,
    types_read: usize,
    /// Past the last name: from the first one on.
    turned: bool,
    /// The devices read before the turn.
    seen: std::collections::HashSet<String>,
    /// Where the limit was reached, and whether a device came after it.
    reached: Option<Value>,
    cut: bool,
}

impl Walk {
    fn new(start: Option<Value>, limit: usize) -> Walk {
        Walk { start, limit, ..Walk::default() }
    }

    fn by_types(&self) -> bool {
        self.types_read < self.limit
    }

    /// One page taken, read by log types or not: what it repeats dropped. Where the next page
    /// begins (`Some(None)`: at the first name); `None`: every device was read.
    fn take(&mut self, p: &mut measure::Page, by_types: bool) -> Option<Option<Value>> {
        let mut done = p.done;
        if self.turned {
            let n = p.readings.len();
            p.readings.retain(|r| !self.seen.contains(&r.device));
            done |= p.readings.len() < n;
        } else if self.start.is_some() {
            self.seen.extend(p.readings.iter().map(|r| r.device.clone()));
        }
        if by_types {
            self.types_read += p.readings.iter().filter_map(|r| r.types.as_ref()).map(Vec::len).sum::<usize>();
            if !self.by_types() {
                self.reached = p.after.clone();
            }
        } else {
            self.cut |= !p.readings.is_empty();
            p.readings.iter_mut().for_each(|r| r.types_truncated = true);
        }
        match done {
            false => Some(p.after.clone()),
            true if self.start.is_some() && !self.turned => {
                self.turned = true;
                Some(None)
            }
            true => None,
        }
    }

    /// Where the next run begins. A run that ended early and did not reach the limit: where it did.
    fn next(self, complete: bool) -> Option<Value> {
        match (self.cut, complete) {
            (true, _) => self.reached,
            (false, true) => None,
            (false, false) => self.start,
        }
    }
}

/// How one cluster's last run read its devices: kept with the tracker so every page and the
/// report can say "N devices read, the list was cut at the cap" — unknown is not zero.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub at: i64,
    /// The window read: `[from, to]`, epoch ms.
    pub from: i64,
    pub to: i64,
    /// Devices read this run (devices that sent at least one document in the window).
    pub devices: u64,
    pub pages: u64,
    pub complete: bool,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_devices: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_device: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// `late` when the run read only the cluster's late devices (*Fetch now*, docs/LOGDELAY.md
    /// "Fetch now"); absent for every device or one device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The log type field it read by, or why none (docs/LOGDELAY.md "Log types"). `None`: a run
    /// before 0.3.90.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_type: Option<LogTypeField>,
    /// Where its log types' limit was reached: the next run begins there (`Walk`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types_after: Option<Value>,
}

impl RunInfo {
    /// The run read part of the list only (one device, the late devices): it says nothing about
    /// the devices it did not read, and is not the cluster's run.
    pub fn is_partial(&self) -> bool {
        self.device.is_some() || self.only.is_some()
    }
}

impl Collected {
    /// How the run read the cluster. A narrowed read (`filter` not `All`) is never `complete`:
    /// the whole list was not read, whatever its last page said.
    pub fn info(&self, at: i64, from: i64, to: i64, max_devices: u64, filter: &DeviceFilter) -> RunInfo {
        RunInfo {
            at, from, to, devices: self.readings.len() as u64, pages: self.pages, complete: self.complete && !filter.is_partial(), truncated: self.truncated,
            max_devices: self.truncated.then_some(max_devices), no_device: self.no_device, device: filter.one().map(String::from),
            only: matches!(filter, DeviceFilter::Some(_)).then(|| "late".to_string()), error: self.error.clone(), log_type: Some(self.log_type.clone()), types_after: self.types_after.clone(),
        }
    }
}

/// The mapping's answer about one field is small and quick; a run does not wait long for it.
const MAPPING_TIMEOUT_MS: u64 = 30_000;

impl Core {
    /// How the cluster's mapping has the log type field: one `_field_caps` per cluster and run,
    /// over the indices with documents in the window (`index_filter`; a cluster too old for it is
    /// asked about the whole pattern). Not answered: as the last run that was, else not known.
    async fn logdelay_log_type(self: &Arc<Self>, id: &str, f: &Fields, from_ms: i64, to_ms: i64) -> LogTypeField {
        let path = format!("/{}/_field_caps?fields={l},{l}.keyword&ignore_unavailable=true&allow_no_indices=true", f.pattern, l = super::levels::LOG_TYPE_FIELD);
        let window = serde_json::json!({ "index_filter": { "range": { f.arrival.clone(): { "gte": from_ms, "lte": to_ms, "format": "epoch_millis" } } } });
        let request = |body: Option<Value>| EsRequest {
            cluster_id: id.to_string(), method: if body.is_some() { "POST" } else { "GET" }.into(), path: path.clone(), body: body.map(|b| b.to_string()),
            timeout_ms: Some(MAPPING_TIMEOUT_MS), origin: Some("delay-sink".into()), class: crate::gate::Class::Background, ..EsRequest::default()
        };
        let mut res = self.es_req(request(Some(window))).await;
        if res.get("status").and_then(Value::as_u64) == Some(400) {
            res = self.es_req(request(None)).await;
        }
        let ok = res.get("ok").and_then(Value::as_bool) == Some(true);
        let got = measure::log_type_field(if ok { res.get("json").unwrap_or(&Value::Null) } else { &Value::Null });
        if got.why.as_deref() != Some(measure::MAPPING_NOT_READ) {
            return got;
        }
        let known = self.logdelay_store().and_then(|st| st.read_tracker(id).last_read.as_ref().and_then(|r| r.log_type.clone()));
        known.filter(|k| k.field.is_some()).unwrap_or(got)
    }

    /// Every device of cluster `id` with a document in `[from_ms, to_ms]` (or the one device,
    /// or the named devices, of `devices`), at most `max_devices`, page by page. `on_page` is
    /// told how many devices are read so far after every page (the run's progress). Stops
    /// between pages when somebody asked the measurement to stop (`JOB_CANCEL`).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn logdelay_collect(self: &Arc<Self>, id: &str, f: &Fields, from_ms: i64, to_ms: i64, max_devices: u64, devices: &DeviceFilter,
                                         mut on_page: impl FnMut(usize)) -> Collected {
        let max = max_devices.clamp(1, measure::MAX_DEVICES_PER_RUN) as usize;
        let allowance = crate::memory::budget().report_page_bytes();
        let mut out = Collected { log_type: self.logdelay_log_type(id, f, from_ms, to_ms).await, ..Collected::default() };
        let f = &Fields { log_type: out.log_type.field.clone(), ..f.clone() };
        let without = &Fields { log_type: None, ..f.clone() };
        let on = f.log_type.is_some() && !devices.is_partial();
        let start = self.logdelay_store().filter(|_| on).and_then(|st| st.read_tracker(id).last_read.as_ref().and_then(|r| r.types_after.clone()));
        let mut walk = Walk::new(start, if f.log_type.is_some() { measure::TYPES_PER_RUN } else { usize::MAX });
        let mut size = if f.log_type.is_some() { measure::PAGE_SIZE_TYPES } else { measure::PAGE_SIZE };
        let mut after: Option<Value> = walk.start.clone();
        let mut tries = 0u32;
        let begun = std::time::Instant::now();
        loop {
            if let Some(by) = self.jobs.cancel_asked(crate::jobs::LOGDELAY_MEASURE) {
                out.error = Some(format!("stopped by {by} after {} devices", out.readings.len()));
                break;
            }
            if begun.elapsed() >= crate::delay_sink::CLUSTER_READ_MAX {
                out.error = Some(format!("the cluster took longer than {} min to read: {} devices read, the rest not measured this run",
                                         crate::delay_sink::CLUSTER_READ_MAX.as_secs() / 60, out.readings.len()));
                break;
            }
            let by_types = walk.by_types();
            let f = if by_types { f } else { without };
            // One more than the cap leaves room for: a device beyond it says the list was cut.
            let ask = size.min(max - out.readings.len() + 1).max(1);
            let body = measure::page_body(f, from_ms, to_ms, ask, after.as_ref(), devices);
            let req = crate::delay_sink::search_request_for(id, &f.pattern, body, PAGE_TIMEOUT_MS);
            let res = self.es_req(req).await;
            let failure = if res.get("ok").and_then(Value::as_bool) != Some(true) {
                if res.get("kind").and_then(Value::as_str) == Some("response_too_large") && size > measure::PAGE_SIZE_MIN {
                    // Too large to read: the same page again, at half the size. Not a failure.
                    size = (size / 2).max(measure::PAGE_SIZE_MIN);
                    continue;
                }
                let why = res.get("message").and_then(Value::as_str).unwrap_or("search failed").to_string();
                // Refused for its log types (too many buckets for this cluster): smaller pages, then
                // without them: the delays are measured, and the log types say they were not read.
                let refused = res.get("status").and_then(Value::as_u64) == Some(400) || res.to_string().contains("too_many_buckets");
                if by_types && f.log_type.is_some() && refused {
                    if size > measure::PAGE_SIZE_MIN {
                        size = measure::PAGE_SIZE_MIN;
                    } else {
                        walk.limit = 0;
                        out.log_type = LogTypeField { field: None, why: Some(format!("the cluster refused the search by log types: {why}")) };
                    }
                    continue;
                }
                if res.get("kind").and_then(Value::as_str) != Some("timeout") {
                    // Refused, unreachable, an HTTP error: asking again at once gets the same.
                    out.error = Some(if out.readings.is_empty() { why } else {
                        format!("page {} failed ({why}): {} devices read, the rest not measured this run", out.pages + 1, out.readings.len())
                    });
                    break;
                }
                Some(why)
            } else {
                let bytes = res.get("bytes").and_then(Value::as_u64).unwrap_or(0);
                match measure::read_page(res.get("json").unwrap_or(&Value::Null), f, ask) {
                    Ok(mut p) => {
                        tries = 0;
                        out.pages += 1;
                        out.largest_page_bytes = out.largest_page_bytes.max(bytes);
                        if out.no_device.is_none() {
                            out.no_device = p.no_device;
                        }
                        let next = walk.take(&mut p, by_types);
                        out.readings.extend(p.readings);
                        if out.readings.len() > max {
                            out.readings.truncate(max);
                            out.truncated = true;
                            on_page(out.readings.len());
                            break;
                        }
                        on_page(out.readings.len());
                        size = measure::next_page_size(size, bytes, allowance);
                        match next {
                            Some(a) => after = a,
                            None => {
                                out.complete = true;
                                break;
                            }
                        }
                        None
                    }
                    Err(PageError::Shape(why)) => {
                        out.error = Some(format!("page {} answered, but {why}: not asked again", out.pages + 1));
                        break;
                    }
                    Err(PageError::Retry(why)) => Some(why),
                }
            };
            if let Some(why) = failure {
                tries += 1;
                if tries >= PAGE_TRIES {
                    out.error = Some(if out.readings.is_empty() {
                        why
                    } else {
                        format!("page {} failed {PAGE_TRIES} times ({why}): {} devices read, the rest not measured this run", out.pages + 1, out.readings.len())
                    });
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * tries as u64)).await;
            }
        }
        out.types_after = walk.next(out.complete).filter(|_| on);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logdelay::measure::{Page, TypeReading};
    use serde_json::json;
    use std::collections::BTreeSet;

    /// One run over `n` devices of two log types, in pages of two, as `logdelay_collect` walks them:
    /// every device read and whether by log types, and where the next run begins.
    fn run(n: usize, limit: usize, start: Option<Value>, pages: usize) -> (Vec<(usize, bool)>, bool, Option<Value>) {
        let mut walk = Walk::new(start, limit);
        let (mut after, mut read, mut complete) = (walk.start.clone(), vec![], false);
        for _ in 0..pages {
            let by_types = walk.by_types();
            let from = after.as_ref().map_or(0, |a: &Value| a["d"].as_u64().unwrap() as usize);
            let ids: Vec<usize> = (from + 1..=n).take(2).collect();
            let readings = ids.iter().map(|i| Reading { device: i.to_string(), types: by_types.then(|| vec![TypeReading::default(), TypeReading { log_type: Some("a".into()), ..Default::default() }]), ..Default::default() }).collect();
            let mut p = Page { readings, after: ids.last().map(|i| json!({ "d": i })), done: ids.len() < 2, no_device: None };
            let next = walk.take(&mut p, by_types);
            read.extend(p.readings.iter().map(|r| {
                assert_eq!(r.types.is_none(), r.types_truncated, "not read, and it says so");
                (r.device.parse::<usize>().unwrap(), r.types.is_some())
            }));
            match next {
                Some(a) => after = a,
                None => { complete = true; break }
            }
        }
        (read, complete, walk.next(complete))
    }

    #[test]
    fn no_device_is_always_past_the_limit_and_every_one_is_read_once_a_run() {
        for n in [1, 2, 7, 8, 9, 20] {
            let (mut start, mut by_types, mut runs) = (None, BTreeSet::new(), 0);
            while by_types.len() < n {
                let (read, complete, next) = run(n, 8, start, 100);
                assert!(complete);
                assert_eq!(read.iter().map(|(d, _)| *d).collect::<BTreeSet<_>>(), (1..=n).collect(), "{n}");
                assert_eq!(read.len(), n, "once each");
                by_types.extend(read.iter().filter(|(_, t)| *t).map(|(d, _)| *d));
                (start, runs) = (next, runs + 1);
            }
            assert_eq!(runs, n.div_ceil(4), "{n} devices, four a run");
        }
        // All of them within the limit: from the first name again, whatever the start was.
        assert_eq!(run(4, 100, Some(json!({ "d": 2 })), 100).2, None);
        assert_eq!(run(4, 8, None, 100).2, None, "the limit reached by the last device: none past it");
        // A start that is past the last name, or whose device is gone.
        assert_eq!(run(4, 100, Some(json!({ "d": 9 })), 100).0.len(), 4);
        // Ended early: the next begins where this one did, or where the limit was reached.
        assert_eq!(run(20, 8, Some(json!({ "d": 6 })), 1).2, Some(json!({ "d": 6 })));
        assert_eq!(run(20, 8, Some(json!({ "d": 6 })), 4).2, Some(json!({ "d": 10 })));
    }
}
