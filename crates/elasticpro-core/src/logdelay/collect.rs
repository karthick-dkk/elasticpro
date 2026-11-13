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

use super::measure::{self, Fields, PageError, Reading};
use crate::bridge::Core;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Collected {
    pub fn info(&self, at: i64, from: i64, to: i64, max_devices: u64, device: Option<&str>) -> RunInfo {
        RunInfo {
            at, from, to, devices: self.readings.len() as u64, pages: self.pages, complete: self.complete, truncated: self.truncated,
            max_devices: self.truncated.then_some(max_devices), no_device: self.no_device, device: device.map(String::from), error: self.error.clone(),
        }
    }
}

impl Core {
    /// Every device of cluster `id` with a document in `[from_ms, to_ms]` (or the one
    /// `device`), at most `max_devices`, page by page. `on_page` is told how many devices are
    /// read so far after every page (the run's progress). Stops between pages when somebody
    /// asked the measurement to stop (`JOB_CANCEL`).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn logdelay_collect(self: &Arc<Self>, id: &str, f: &Fields, from_ms: i64, to_ms: i64, max_devices: u64, device: Option<&str>,
                                         mut on_page: impl FnMut(usize)) -> Collected {
        let max = max_devices.clamp(1, measure::MAX_DEVICES_PER_RUN) as usize;
        let allowance = crate::memory::budget().report_page_bytes();
        let mut out = Collected::default();
        let mut size = measure::PAGE_SIZE;
        let mut after: Option<Value> = None;
        let mut tries = 0u32;
        loop {
            if let Some(by) = self.jobs.cancel_asked(crate::jobs::LOGDELAY_MEASURE) {
                out.error = Some(format!("stopped by {by} after {} devices", out.readings.len()));
                break;
            }
            // One more than the cap leaves room for: a device beyond it says the list was cut.
            let ask = size.min(max - out.readings.len() + 1).max(1);
            let body = measure::page_body(f, from_ms, to_ms, ask, after.as_ref(), device);
            let mut req = crate::delay_sink::search_request_for(id, &f.pattern, body);
            req.timeout_ms = Some(PAGE_TIMEOUT_MS);
            let res = self.es_req(req).await;
            let failure = if res.get("ok").and_then(Value::as_bool) != Some(true) {
                if res.get("kind").and_then(Value::as_str) == Some("response_too_large") && size > measure::PAGE_SIZE_MIN {
                    // Too large to read: the same page again, at half the size. Not a failure.
                    size = (size / 2).max(measure::PAGE_SIZE_MIN);
                    continue;
                }
                let why = res.get("message").and_then(Value::as_str).unwrap_or("search failed").to_string();
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
                    Ok(p) => {
                        tries = 0;
                        out.pages += 1;
                        out.largest_page_bytes = out.largest_page_bytes.max(bytes);
                        if out.no_device.is_none() {
                            out.no_device = p.no_device;
                        }
                        out.readings.extend(p.readings);
                        if out.readings.len() > max {
                            out.readings.truncate(max);
                            out.truncated = true;
                            on_page(out.readings.len());
                            break;
                        }
                        on_page(out.readings.len());
                        size = measure::next_page_size(size, bytes, allowance);
                        if p.done {
                            out.complete = true;
                            break;
                        }
                        after = p.after;
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
        out
    }
}
