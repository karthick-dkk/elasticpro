//! A run's details (docs/JOBS.md "Run details"): what happened on each cluster it touched and
//! the lines the core and the worker wrote while it ran — read with `JOB_RUN_DETAIL` when a row
//! of Jobs › All jobs is opened.
//!
//! * `ErrorCode::of` — the one definition that turns an error's text into a code from a small
//!   fixed set. `retry_text` and `what_to_do` say, for a job and a code, when it is tried again
//!   and what a person can do about it (only where ElasticPro knows).
//! * `Collecting` — what a run gathers while it goes (held by `capture`, keyed by run id): its
//!   parts and its lines, both bounded. `finish` turns it into the `RunDetail` that is written
//!   once, when the run ends, beside the run log (`<data>/job-runs/detail/<owner>/<run id>.json`)
//!   and kept as long as the run log keeps the run, never longer than `DETAIL_KEEP_MS`.
//! * `detail_view` — the detail as a caller may read it: a caller limited to some clusters reads
//!   only their clusters' parts and lines, and totals counted from those.
//!
//! Pure: no clock, no I/O.

use crate::delay_sink::SinkView;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::LazyLock;

/// Successful parts listed by name; past this they are counted only (`partsNotListed`).
pub const SUCCESS_LISTED: usize = 300;
/// Exceptions (every part that did not succeed) are all kept, up to this hard bound — far
/// above any fleet, there only so a run record can never grow without end.
pub const EXCEPTIONS_MAX: usize = 2_000;
/// A run's lines: the first `LINES_HEAD` and the last `LINES_TAIL` (500 in all); the ones in
/// between are counted (`linesDropped`), not kept.
pub const LINES_HEAD: usize = 100;
pub const LINES_TAIL: usize = 400;
/// One line's text (and a part's message), at most, after `redact`.
pub const LINE_MAX_CHARS: usize = 300;
/// `<data>/job-runs/detail/`: one file per run, under its owner.
pub const DIR: &str = "detail";
/// A run's detail is kept as long as the run log keeps the run, and never longer than this.
pub const DETAIL_KEEP_MS: u64 = 7 * 24 * 3600 * 1000;

/// How one cluster's part of a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PartStatus {
    Succeeded,
    /// Some of it done, some not (part of the devices read, a day of several failed).
    Partial,
    Failed,
    /// Held back for a reason that passes (a busy cluster, the emergency stop): a warning,
    /// tried again by the job's own rules.
    Deferred,
    /// Nothing attempted (cancelled before its turn, nothing to do).
    Skipped,
}

impl PartStatus {
    pub const ALL: [PartStatus; 5] = [PartStatus::Succeeded, PartStatus::Partial, PartStatus::Failed, PartStatus::Deferred, PartStatus::Skipped];
}

/// What went wrong, from a small fixed set (docs/JOBS.md "Error codes"). `of` is the one
/// definition of which text is which.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    IndexNotFound,
    Timeout,
    ShardFailure,
    Busy,
    Auth,
    Unreachable,
    Other,
}

static URL_USERINFO: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s]+@").expect("a fixed pattern"));
static AUTH_SCHEME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\b(Basic|Bearer|ApiKey)\s+[A-Za-z0-9._~+/=-]+").expect("a fixed pattern"));
static SECRET_FIELD: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\b(authorization|x-api-key|api[-_]?key|password|passwd|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',;}&]+"#).expect("a fixed pattern")
});

/// The one redaction every captured line and every part's message goes through before it is
/// kept (docs/JOBS.md "Run details"): a URL's userinfo (`https://user:pass@host` →
/// `https://***@host`), the value after `Basic` / `Bearer` / `ApiKey`, and the value of an
/// `Authorization`, API key, password, secret or token field; then cut to `LINE_MAX_CHARS`.
pub fn redact(text: &str) -> String {
    let s = URL_USERINFO.replace_all(text, "${1}***@");
    let s = AUTH_SCHEME.replace_all(&s, "${1} ***");
    let s = SECRET_FIELD.replace_all(&s, "${1}${2}***");
    cut(&s, LINE_MAX_CHARS)
}

static AUTH_STATUS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\b(401|403)\b").expect("a fixed pattern"));
static BUSY_STATUS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\b429\b").expect("a fixed pattern"));

impl ErrorCode {
    pub const ALL: [ErrorCode; 7] = [ErrorCode::IndexNotFound, ErrorCode::Timeout, ErrorCode::ShardFailure, ErrorCode::Busy,
                                     ErrorCode::Auth, ErrorCode::Unreachable, ErrorCode::Other];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::IndexNotFound => "INDEX_NOT_FOUND",
            ErrorCode::Timeout => "TIMEOUT",
            ErrorCode::ShardFailure => "SHARD_FAILURE",
            ErrorCode::Busy => "BUSY",
            ErrorCode::Auth => "AUTH",
            ErrorCode::Unreachable => "UNREACHABLE",
            ErrorCode::Other => "OTHER",
        }
    }

    /// The code an error's text says. Checked in this order, the first that matches wins:
    /// refused credentials, a busy cluster, a missing index, failed shards, a time-out, a
    /// cluster that cannot be reached; anything else is `OTHER`.
    pub fn of(text: &str) -> ErrorCode {
        let t = text.to_ascii_lowercase();
        let any = |words: &[&str]| words.iter().any(|w| t.contains(w));
        if AUTH_STATUS.is_match(&t) || any(&["unauthorized", "forbidden", "security_exception", "authentication", "bad credentials", "wrong password", "no_creds", "not primed"]) {
            ErrorCode::Auth
        } else if BUSY_STATUS.is_match(&t) || any(&["too many requests", "rejected_execution", "rejected execution", "circuit_breaking", " is busy", "search queue", "answers over"]) {
            ErrorCode::Busy
        } else if any(&["index_not_found", "no such index", "no index matches", "matches no index", "no device aggregation", "no indices", "no log index"]) {
            ErrorCode::IndexNotFound
        } else if any(&["shard", "search_phase_execution", "partial answer"]) {
            ErrorCode::ShardFailure
        } else if any(&["timed out", "timeout", "time-out", "deadline"]) {
            ErrorCode::Timeout
        } else if any(&["connection refused", "unreachable", "could not connect", "connect error", "error trying to connect", "dns", "resolve", "no route",
                        "tunnel", "jump host", "ssh", "connection reset", "broken pipe", "network"]) {
            ErrorCode::Unreachable
        } else {
            ErrorCode::Other
        }
    }
}

/// What a person can do about a part that did not succeed, where ElasticPro knows: a short
/// label for the link, the sentence, and the page that has the setting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Todo {
    pub label: String,
    pub text: String,
    pub page: String,
}

fn todo(label: &str, text: &str, page: &str) -> Option<Todo> {
    Some(Todo { label: label.into(), text: text.into(), page: page.into() })
}

/// What to do about `code` on a run of `job`, or `None` when there is nothing a person need do
/// (a busy cluster is tried again by itself) or ElasticPro does not know.
pub fn what_to_do(job: &str, code: ErrorCode) -> Option<Todo> {
    match code {
        ErrorCode::IndexNotFound if job == super::LOGDELAY_MEASURE => todo("Set log index", "set the cluster's log index (Config › Clusters)", "settings"),
        ErrorCode::IndexNotFound => todo("Set index pattern", "set the cluster's volume index pattern (Reports › Settings)", "reports"),
        ErrorCode::Timeout => todo("Cluster health", "the cluster did not answer in time: look at its health and load (Clusters)", "overview"),
        ErrorCode::ShardFailure => todo("Shard status", "some shards failed: look at shard allocation (Nodes & shards)", "shards"),
        ErrorCode::Auth => todo("Credentials", "check the cluster's user and password (Config › Clusters)", "settings"),
        ErrorCode::Unreachable => todo("Connection", "check the cluster's address or jump host (Config › Clusters)", "settings"),
        ErrorCode::Busy | ErrorCode::Other => None,
    }
}

/// When a part that did not succeed is tried again, in words: the job's own rule.
pub fn retry_text(job: &str, status: PartStatus, code: Option<ErrorCode>) -> Option<String> {
    let s = match (status, code) {
        (PartStatus::Succeeded, _) => return None,
        (_, Some(ErrorCode::IndexNotFound | ErrorCode::Auth)) => "None — config issue",
        (PartStatus::Deferred, _) | (_, Some(ErrorCode::Busy)) => "When the cluster eases (automatic)",
        _ if job == super::HOSTS_COLLECT => "Next tick, up to 3 tries a day",
        _ if job == super::VOLUME_DAILY => "Next scheduled run",
        _ => "Next run",
    };
    Some(s.to_string())
}

/// One cluster's part of a run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub cluster: String,
    pub status: PartStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Records it processed (devices measured, days collected); `None` when not known.
    #[serde(default)]
    pub records: Option<u64>,
    #[serde(default)]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo: Option<Todo>,
}

impl Part {
    /// A cluster done in full.
    pub fn ok(cluster: &str, records: Option<u64>, elapsed_ms: Option<u64>) -> Part {
        Part { cluster: cluster.into(), status: PartStatus::Succeeded, code: None, message: None, records, elapsed_ms, retry: None, todo: None }
    }

    /// A cluster that did not succeed, `error` saying why: its code, retry and what to do
    /// worked out here, once. A deferral is a busy cluster's unless its text says otherwise.
    pub fn not_ok(job: &str, cluster: &str, status: PartStatus, error: &str, records: Option<u64>, elapsed_ms: Option<u64>) -> Part {
        // Switched off for this cluster (Edit cluster › Collection): not an error at all — no
        // code, and the one place that turns it back on.
        if crate::collection::is_off_text(error) {
            return Part {
                cluster: cluster.into(), status, code: None, message: Some(redact(error)), records, elapsed_ms,
                retry: Some(format!("When it is switched on again ({})", crate::collection::WHERE)),
                todo: todo("Edit cluster", "switched off for this cluster: turn it on in Edit cluster › Collection (Config › Clusters)", "settings"),
            };
        }
        let mut code = ErrorCode::of(error);
        if status == PartStatus::Deferred && code == ErrorCode::Other {
            code = ErrorCode::Busy;
        }
        let code = (status != PartStatus::Skipped || code != ErrorCode::Other).then_some(code);
        Part {
            cluster: cluster.into(), status, code, message: Some(redact(error)), records, elapsed_ms,
            retry: retry_text(job, status, code), todo: code.and_then(|c| what_to_do(job, c)),
        }
    }
}

/// How many parts ended which way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartCounts {
    #[serde(default)]
    pub succeeded: u64,
    #[serde(default)]
    pub partial: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub deferred: u64,
    #[serde(default)]
    pub skipped: u64,
}

impl PartCounts {
    pub fn add(&mut self, s: PartStatus) {
        *self.slot(s) += 1;
    }
    fn slot(&mut self, s: PartStatus) -> &mut u64 {
        match s {
            PartStatus::Succeeded => &mut self.succeeded,
            PartStatus::Partial => &mut self.partial,
            PartStatus::Failed => &mut self.failed,
            PartStatus::Deferred => &mut self.deferred,
            PartStatus::Skipped => &mut self.skipped,
        }
    }
    /// Every part: the five always add up to this.
    pub fn total(&self) -> u64 {
        self.succeeded + self.partial + self.failed + self.deferred + self.skipped
    }
    /// Parts that did not succeed: the Exceptions tab.
    pub fn exceptions(&self) -> u64 {
        self.total() - self.succeeded
    }
}

/// One line the run wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Unix ms.
    pub at: u64,
    /// `INFO`, `WARN`, `ERROR` (as the log writes them).
    pub level: String,
    /// The cluster the line is about, when it names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    /// A line ElasticPro writes about the run as a whole (its start and end), which names no
    /// cluster: kept for a caller limited to some clusters.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub run: bool,
    pub text: String,
}

/// `text`, at most `n` characters, an ellipsis where it was cut.
pub fn cut(text: &str, n: usize) -> String {
    if text.chars().count() <= n {
        return text.to_string();
    }
    let mut s: String = text.chars().take(n.saturating_sub(1)).collect();
    s.push('…');
    s
}

/// What a run gathers while it goes. Bounded however long it runs.
#[derive(Clone, Debug, Default)]
pub struct Collecting {
    exceptions: Vec<Part>,
    succeeded: Vec<Part>,
    counts: PartCounts,
    /// Exceptions past `EXCEPTIONS_MAX` and successes past `SUCCESS_LISTED`: counted only.
    not_listed: u64,
    head: Vec<Line>,
    tail: VecDeque<Line>,
    dropped: u64,
    window: Option<(i64, i64)>,
}

impl Collecting {
    /// One cluster's part. A second part for the same cluster replaces the first (its counts
    /// moved with it): a cluster is one part of a run, however it is reported.
    pub fn part(&mut self, p: Part) {
        let listed = self.exceptions.iter().chain(self.succeeded.iter()).position(|x| x.cluster == p.cluster);
        if let Some(i) = listed {
            let old = if i < self.exceptions.len() { self.exceptions.remove(i) } else { self.succeeded.remove(i - self.exceptions.len()) };
            let slot = self.counts.slot(old.status);
            *slot = slot.saturating_sub(1);
        }
        self.counts.add(p.status);
        if p.status == PartStatus::Succeeded {
            if self.succeeded.len() < SUCCESS_LISTED { self.succeeded.push(p) } else { self.not_listed += 1 }
        } else if self.exceptions.len() < EXCEPTIONS_MAX {
            self.exceptions.push(p);
        } else {
            self.not_listed += 1;
        }
    }

    /// One line: the first `LINES_HEAD` and the last `LINES_TAIL` are kept.
    pub fn line(&mut self, mut l: Line) {
        l.text = redact(&l.text);
        if self.head.len() < LINES_HEAD {
            self.head.push(l);
            return;
        }
        if self.tail.len() == LINES_TAIL {
            self.tail.pop_front();
            self.dropped += 1;
        }
        self.tail.push_back(l);
    }

    /// The time window the run read, when it reads one (the log delay measurement's).
    pub fn window(&mut self, from: i64, to: i64) {
        self.window = Some((from, to));
    }

    pub fn counts(&self) -> PartCounts {
        self.counts
    }

    /// The detail written when the run ends: exceptions first (worst first, then by cluster),
    /// then the clusters that succeeded.
    pub fn finish(self) -> RunDetail {
        let rank = |s: PartStatus| match s {
            PartStatus::Failed => 0,
            PartStatus::Partial => 1,
            PartStatus::Deferred => 2,
            _ => 3,
        };
        let mut ex = self.exceptions;
        ex.sort_by(|a, b| rank(a.status).cmp(&rank(b.status)).then_with(|| a.cluster.cmp(&b.cluster)));
        let mut ok = self.succeeded;
        ok.sort_by(|a, b| a.cluster.cmp(&b.cluster));
        let mut lines = self.head;
        lines.extend(self.tail);
        RunDetail { version: 1, counts: self.counts, parts: ex.into_iter().chain(ok).collect(), parts_not_listed: self.not_listed,
                    lines, lines_dropped: self.dropped, window: self.window }
    }
}

/// A finished run's detail, as written beside the run log.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub counts: PartCounts,
    #[serde(default)]
    pub parts: Vec<Part>,
    /// Parts counted in `counts` but not in `parts` (past the bounds).
    #[serde(default)]
    pub parts_not_listed: u64,
    #[serde(default)]
    pub lines: Vec<Line>,
    /// Lines between the first and the last kept, counted only.
    #[serde(default)]
    pub lines_dropped: u64,
    #[serde(default)]
    pub window: Option<(i64, i64)>,
}

/// The detail as `view` may read it. A caller who sees every cluster reads it whole; a caller
/// limited to some clusters reads only their clusters' parts, the lines about their clusters
/// and the run's own start and end lines, and totals counted from the parts they read
/// (`narrowed: true`) — so the totals still add up, and say nothing of anybody else's.
pub fn detail_view(d: &RunDetail, view: &SinkView) -> Value {
    if view.visible.is_none() {
        return json!({ "counts": d.counts, "parts": d.parts, "partsNotListed": d.parts_not_listed,
                       "lines": d.lines, "linesDropped": d.lines_dropped, "window": d.window, "narrowed": false });
    }
    let parts: Vec<&Part> = d.parts.iter().filter(|p| view.sees(&p.cluster)).collect();
    let mut counts = PartCounts::default();
    for p in &parts {
        counts.add(p.status);
    }
    let lines: Vec<&Line> = d.lines.iter().filter(|l| match &l.cluster {
        Some(c) => view.sees(c),
        None => l.run,
    }).collect();
    // Successes past the list: whose they were is not known, so not said either way.
    json!({ "counts": counts, "parts": parts, "partsNotListed": d.parts_not_listed,
            "lines": lines, "linesDropped": d.lines_dropped, "window": d.window, "narrowed": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_error_code_comes_from_the_text_once() {
        let cases = [
            ("the answer has no device aggregation", ErrorCode::IndexNotFound),
            ("index_not_found_exception: no such index [logstash-*]", ErrorCode::IndexNotFound),
            ("the request timed out", ErrorCode::Timeout),
            ("operation timed out after 30 s (page 1)", ErrorCode::Timeout),
            ("2 of 5 shards failed", ErrorCode::ShardFailure),
            ("search_phase_execution_exception", ErrorCode::ShardFailure),
            ("the cluster answered 429 Too Many Requests", ErrorCode::Busy),
            ("es_rejected_execution_exception: rejected execution", ErrorCode::Busy),
            ("c1 is busy: answers over 8 s; tried again when it eases", ErrorCode::Busy),
            ("HTTP 401 Unauthorized", ErrorCode::Auth),
            ("security_exception: action is forbidden", ErrorCode::Auth),
            ("Not primed; re-priming.", ErrorCode::Auth),
            ("connection refused", ErrorCode::Unreachable),
            ("the jump host bastion did not answer", ErrorCode::Unreachable),
            ("something nobody expected", ErrorCode::Other),
            ("", ErrorCode::Other),
        ];
        for (text, want) in cases {
            assert_eq!(ErrorCode::of(text), want, "{text:?}");
        }
        // A number that only contains 401 or 429 is not a status.
        assert_eq!(ErrorCode::of("14012 devices, 4290 readings, then it broke"), ErrorCode::Other);
        // Every code has its own name, written as the API names it.
        let names: std::collections::HashSet<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(names.len(), ErrorCode::ALL.len());
        for c in ErrorCode::ALL {
            assert_eq!(serde_json::to_value(c).unwrap(), json!(c.as_str()));
        }
    }

    #[test]
    fn credentials_never_reach_a_line_or_a_message() {
        let r = redact("GET https://elastic:s3cr3t@es1.example:9200/_search failed; Authorization: Basic ZWxhc3RpYzpzM2NyM3Q= sent");
        assert!(!r.contains("s3cr3t") && !r.contains("ZWxhc3RpYzpzM2NyM3Q"), "{r}");
        assert!(r.contains("https://***@es1.example:9200/_search"), "{r}");
        let r = redact(r#"headers {"Authorization":"ApiKey abc123=="} x-api-key=k-999 Bearer eyJhbGciOi.x.y token=t0k"#);
        for secret in ["abc123", "k-999", "eyJhbGciOi", "t0k"] {
            assert!(!r.contains(secret), "{secret} in {r}");
        }
        assert_eq!(redact("prod ok records=3"), "prod ok records=3", "nothing to hide: as it was");
        assert!(redact(&"x".repeat(1000)).chars().count() <= LINE_MAX_CHARS);
        let mut c = Collecting::default();
        c.line(Line { at: 1, level: "ERROR".into(), cluster: Some("a".into()), run: false, text: "http://u:p@h/x".into() });
        let p = Part::not_ok("j", "a", PartStatus::Failed, "connection refused: https://admin:hunter2@10.0.0.1:9200", None, None);
        assert!(!p.message.as_deref().unwrap().contains("hunter2"));
        assert_eq!(c.finish().lines[0].text, "http://***@h/x");
    }

    #[test]
    fn a_part_says_its_retry_and_what_to_do() {
        let p = Part::not_ok(super::super::LOGDELAY_MEASURE, "demo", PartStatus::Failed, "the answer has no device aggregation", Some(0), Some(400));
        assert_eq!(p.code, Some(ErrorCode::IndexNotFound));
        assert_eq!(p.retry.as_deref(), Some("None — config issue"));
        let t = p.todo.expect("a missing log index has a fix");
        assert_eq!(t.text, "set the cluster's log index (Config › Clusters)");
        assert_eq!(t.page, "settings");
        let d = Part::not_ok(super::super::HOSTS_COLLECT, "ussc", PartStatus::Deferred, "held back", None, None);
        assert_eq!(d.code, Some(ErrorCode::Busy), "a deferral with no other reason is a busy cluster's");
        assert_eq!(d.retry.as_deref(), Some("When the cluster eases (automatic)"));
        assert!(d.todo.is_none(), "nothing to do: it is tried again by itself");
        let t = Part::not_ok(super::super::HOSTS_COLLECT, "x", PartStatus::Failed, "the request timed out", None, None);
        assert_eq!(t.retry.as_deref(), Some("Next tick, up to 3 tries a day"));
        assert!(Part::ok("a", Some(3), Some(10)).retry.is_none());
    }

    #[test]
    fn parts_are_bounded_successes_counted_and_every_exception_kept() {
        let mut c = Collecting::default();
        let n_ok = SUCCESS_LISTED + 25;
        for i in 0..n_ok {
            c.part(Part::ok(&format!("ok{i:04}"), Some(1), None));
        }
        for i in 0..40 {
            c.part(Part::not_ok("j", &format!("bad{i:02}"), PartStatus::Failed, "timed out", None, None));
        }
        c.part(Part::not_ok("j", "half", PartStatus::Partial, "2 of 5 shards failed", Some(5), None));
        let d = c.finish();
        assert_eq!(d.counts.succeeded, n_ok as u64);
        assert_eq!(d.counts.failed, 40);
        assert_eq!(d.counts.partial, 1);
        assert_eq!(d.counts.total(), n_ok as u64 + 41, "the totals add up");
        assert_eq!(d.counts.exceptions(), 41);
        assert_eq!(d.parts.iter().filter(|p| p.status != PartStatus::Succeeded).count(), 41, "every exception is listed");
        assert_eq!(d.parts.iter().filter(|p| p.status == PartStatus::Succeeded).count(), SUCCESS_LISTED);
        assert_eq!(d.parts_not_listed, 25);
        assert_eq!(d.parts[0].status, PartStatus::Failed, "the worst first");
        assert_eq!(d.parts[40].cluster, "half");
        // A cluster reported twice is one part: the second wins, the counts follow.
        let mut c = Collecting::default();
        c.part(Part::ok("a", Some(1), None));
        c.part(Part::not_ok("j", "a", PartStatus::Failed, "boom", None, None));
        assert_eq!(c.counts(), PartCounts { failed: 1, ..Default::default() });
        assert_eq!(c.finish().parts.len(), 1);
    }

    #[test]
    fn lines_keep_the_first_and_the_last() {
        let mut c = Collecting::default();
        let n = LINES_HEAD + LINES_TAIL + 77;
        for i in 0..n {
            c.line(Line { at: i as u64, level: "INFO".into(), cluster: None, run: false, text: format!("line {i} {}", "x".repeat(if i == 0 { 2000 } else { 1 })) });
        }
        let d = c.finish();
        assert_eq!(d.lines.len(), LINES_HEAD + LINES_TAIL);
        assert_eq!(d.lines_dropped, 77);
        assert_eq!(d.lines[0].at, 0);
        assert_eq!(d.lines.last().unwrap().at, n as u64 - 1, "the last line (the run's end) is kept");
        assert_eq!(d.lines[LINES_HEAD].at, (LINES_HEAD + 77) as u64);
        assert!(d.lines[0].text.chars().count() <= LINE_MAX_CHARS && d.lines[0].text.ends_with('…'));
    }

    #[test]
    fn a_caller_limited_to_some_clusters_reads_only_theirs() {
        let mut c = Collecting::default();
        c.part(Part::ok("mine", Some(4), None));
        c.part(Part::not_ok("j", "theirs", PartStatus::Failed, "timed out", None, None));
        c.part(Part::not_ok("j", "mine2", PartStatus::Deferred, "mine2 is busy", None, None));
        c.line(Line { at: 1, level: "INFO".into(), cluster: None, run: true, text: "run.start".into() });
        c.line(Line { at: 2, level: "ERROR".into(), cluster: Some("theirs".into()), run: false, text: "theirs TIMEOUT".into() });
        c.line(Line { at: 3, level: "INFO".into(), cluster: Some("mine".into()), run: false, text: "mine ok".into() });
        c.line(Line { at: 4, level: "INFO".into(), cluster: None, run: false, text: "failed_clusters=theirs".into() });
        let d = c.finish();
        let all = detail_view(&d, &SinkView::default());
        assert_eq!(all["parts"].as_array().unwrap().len(), 3);
        assert_eq!(all["lines"].as_array().unwrap().len(), 4);
        assert_eq!(all["narrowed"], json!(false));
        let view = SinkView { visible: Some(["mine".to_string(), "mine2".to_string()].into_iter().collect()) };
        let v = detail_view(&d, &view);
        let clusters: Vec<&str> = v["parts"].as_array().unwrap().iter().map(|p| p["cluster"].as_str().unwrap()).collect();
        assert_eq!(clusters, vec!["mine2", "mine"]);
        assert_eq!(v["counts"], json!({ "succeeded": 1, "partial": 0, "failed": 0, "deferred": 1, "skipped": 0 }), "totals of what they read");
        let texts: Vec<&str> = v["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(texts, vec!["run.start", "mine ok"], "another's lines and untagged lines are not theirs");
        assert!(!v.to_string().contains("theirs"));
    }
}
